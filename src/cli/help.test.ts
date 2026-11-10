import { describe, it, expect } from 'vitest'
import { GLOBAL_HELP, helpFor } from './help'
import { parseCommand } from './args'
import { CONTROL_METHODS } from '../shared/control-protocol'

/** Every command word-pair the CLI exposes, with the method it calls. */
const COMMANDS: Record<string, string> = {
  'projects list': 'projects.list',
  'task create': 'task.create',
  'task list': 'task.list',
  'session open': 'session.open',
  'issues list': 'issues.list',
  'issues get': 'issues.get',
  'issues add': 'issues.add'
}

/** Minimal valid trailing args per command (required flags / positionals). */
const MINIMAL_ARGS: Record<string, string[]> = {
  'projects list': [],
  'task create': ['--project', 'p', '--branch', 'b'],
  'task list': [],
  'session open': ['task-1'],
  'issues list': [],
  'issues get': ['issue-1'],
  'issues add': ['--name', 'n']
}

describe('help', () => {
  it('every command in the table parses to a call of its method', () => {
    expect(Object.keys(MINIMAL_ARGS).sort()).toEqual(Object.keys(COMMANDS).sort())
    for (const [cmd, method] of Object.entries(COMMANDS)) {
      const r = parseCommand([...cmd.split(' '), ...MINIMAL_ARGS[cmd]])
      expect(r.kind, cmd).toBe('call')
      if (r.kind === 'call') expect(r.method, cmd).toBe(method)
    }
  })

  it('the command table covers every protocol method', () => {
    expect(Object.values(COMMANDS).sort()).toEqual([...CONTROL_METHODS].sort())
  })

  it('--help lists every command and the exit codes', () => {
    for (const cmd of Object.keys(COMMANDS)) expect(GLOBAL_HELP).toContain(cmd)
    for (const code of ['0 ', '1 ', '2 ', '3 ']) expect(GLOBAL_HELP).toContain(`  ${code}`)
    expect(GLOBAL_HELP).toContain('OCTOPUS_CONTROL_SOCKET')
  })

  it('every command has its own help text naming the command', () => {
    for (const cmd of Object.keys(COMMANDS)) {
      const h = helpFor(cmd)
      expect(h, cmd).toBeDefined()
      expect(h).toContain(`octopus-cli ${cmd}`)
    }
    expect(helpFor('nope nope')).toBeUndefined()
  })

  it('top-level --help and per-command --help are routed to the right text', () => {
    expect(parseCommand(['--help'])).toEqual({ kind: 'help', text: GLOBAL_HELP })
    for (const cmd of Object.keys(COMMANDS)) {
      expect(parseCommand([...cmd.split(' '), '--help'])).toEqual({
        kind: 'help',
        text: helpFor(cmd)
      })
    }
  })
})
