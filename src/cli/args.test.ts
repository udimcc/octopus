import { describe, it, expect } from 'vitest'
import { parseCommand } from './args'

const call = (argv: string[]) => {
  const r = parseCommand(argv)
  if (r.kind !== 'call') throw new Error(`expected call, got ${r.kind}: ${JSON.stringify(r)}`)
  return r
}
const usage = (argv: string[]): string => {
  const r = parseCommand(argv)
  if (r.kind !== 'usage') throw new Error(`expected usage, got ${r.kind}`)
  return r.message
}

describe('parseCommand dispatch', () => {
  it('no args shows the global help', () => {
    expect(parseCommand([]).kind).toBe('help')
  })

  it('options without a command is a usage error', () => {
    expect(usage(['--project', 'x'])).toContain('missing command')
  })

  it('unknown command is a usage error naming it', () => {
    expect(usage(['frobnicate'])).toContain('unknown command "frobnicate"')
    expect(usage(['task', 'explode'])).toContain('unknown command "task explode"')
  })

  it('a bare group with --help shows global help; without it is a usage error', () => {
    expect(parseCommand(['task', '--help']).kind).toBe('help')
    expect(usage(['task'])).toContain('unknown command')
  })

  it('-h is an alias of --help', () => {
    expect(parseCommand(['projects', 'list', '-h']).kind).toBe('help')
  })
})

describe('parseCommand per command', () => {
  it('projects list', () => {
    expect(call(['projects', 'list'])).toEqual({
      kind: 'call',
      method: 'projects.list',
      params: {}
    })
  })

  it('task create maps flags to camelCase params and drops absent ones', () => {
    expect(
      call([
        'task',
        'create',
        '--project',
        'app',
        '--branch',
        'feat/x',
        '--source-branch',
        'dev',
        '--name',
        'N'
      ]).params
    ).toEqual({ project: 'app', branch: 'feat/x', sourceBranch: 'dev', name: 'N' })
    expect(call(['task', 'create', '--project', 'app', '--branch', 'b']).params).toEqual({
      project: 'app',
      branch: 'b'
    })
  })

  it('task create requires --project and --branch (and non-empty)', () => {
    expect(usage(['task', 'create', '--branch', 'b'])).toContain('--project is required')
    expect(usage(['task', 'create', '--project', 'p'])).toContain('--branch is required')
    expect(usage(['task', 'create', '--project', '', '--branch', 'b'])).toContain(
      '--project is required'
    )
  })

  it('task list with and without a project filter', () => {
    expect(call(['task', 'list']).params).toEqual({})
    expect(call(['task', 'list', '--project', 'app']).params).toEqual({ project: 'app' })
  })

  it('session open takes <taskId> and an optional --command', () => {
    expect(call(['session', 'open', 't1']).params).toEqual({ taskId: 't1' })
    expect(call(['session', 'open', 't1', '--command', 'hi']).params).toEqual({
      taskId: 't1',
      command: 'hi'
    })
    expect(call(['session', 'open', '--command', 'hi', 't1']).params).toEqual({
      taskId: 't1',
      command: 'hi'
    })
  })

  it('session open passes --name through', () => {
    expect(call(['session', 'open', 't1', '--name', 'Fix rejects']).params).toEqual({
      taskId: 't1',
      name: 'Fix rejects'
    })
  })

  it('session open: missing or extra positional is a usage error', () => {
    expect(usage(['session', 'open'])).toContain('missing <taskId>')
    expect(usage(['session', 'open', 'a', 'b'])).toContain('unexpected argument "b"')
  })

  it('a command starting with "-" works via --command=<text>', () => {
    expect(call(['session', 'open', 't1', '--command=-x']).params.command).toBe('-x')
  })

  it('--command - requests stdin for the command field', () => {
    const r = call(['session', 'open', 't1', '--command', '-'])
    expect(r.stdinField).toBe('command')
    expect(r.params.command).toBe('-')
  })

  it('--description - requests stdin for the description; a normal value does not', () => {
    expect(call(['issues', 'add', '--name', 'n', '--description', '-']).stdinField).toBe(
      'description'
    )
    expect(call(['issues', 'add', '--name', 'n', '--description', 'x']).stdinField).toBeUndefined()
  })

  it('a "-" in an unrelated field does not trigger stdin', () => {
    expect(call(['issues', 'add', '--name', '-']).stdinField).toBeUndefined()
  })

  it('issues add defaults description to empty and requires --name', () => {
    expect(call(['issues', 'add', '--name', 'n']).params).toEqual({ name: 'n', description: '' })
    expect(usage(['issues', 'add'])).toContain('--name is required')
  })

  it('issues add passes project and status through', () => {
    expect(
      call(['issues', 'add', '--name', 'n', '--project', 'p', '--status', 'in_review']).params
    ).toEqual({ name: 'n', description: '', project: 'p', status: 'in_review' })
  })

  it('issues list validates --status client-side', () => {
    expect(call(['issues', 'list', '--status', 'done']).params).toEqual({ status: 'done' })
    expect(usage(['issues', 'list', '--status', 'wip'])).toContain('--status must be one of')
    expect(usage(['issues', 'add', '--name', 'n', '--status', 'wip'])).toContain(
      '--status must be one of'
    )
  })

  it('issues get --markdown asks for markdown output without sending a param', () => {
    const r = call(['issues', 'get', 'i1', '--markdown'])
    expect(r.params).toEqual({ issueId: 'i1' })
    expect(r.output).toBe('markdown')
    expect(call(['issues', 'get', 'i1']).output).toBeUndefined()
    expect(usage(['issues', 'list', '--markdown'])).toMatch(/^issues list: /)
  })

  it('issues get takes an <issueId>', () => {
    expect(call(['issues', 'get', 'i1']).params).toEqual({ issueId: 'i1' })
    expect(usage(['issues', 'get'])).toContain('missing <issueId>')
  })

  it('unknown flags and missing flag values are usage errors prefixed with the command', () => {
    expect(usage(['task', 'list', '--bogus'])).toMatch(/^task list: /)
    expect(usage(['task', 'list', '--project'])).toMatch(/^task list: /)
  })
})
