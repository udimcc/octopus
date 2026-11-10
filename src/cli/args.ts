import { parseArgs } from 'node:util'
import type { ControlMethod } from '../shared/control-protocol'
import { GLOBAL_HELP, helpFor } from './help'

/** Which free-text param must be filled from stdin before sending (`--flag -`). */
export type StdinField = 'command' | 'description'

export type ParsedCommand =
  | { readonly kind: 'help'; readonly text: string }
  | { readonly kind: 'usage'; readonly message: string }
  | {
      readonly kind: 'call'
      readonly method: ControlMethod
      /** Params; a `stdinField` entry is a placeholder until stdin is read. */
      readonly params: Record<string, unknown>
      readonly stdinField?: StdinField
      /** Render the result as markdown instead of JSON (`issues get --markdown`). */
      readonly output?: 'markdown'
    }

const STATUSES: readonly string[] = ['todo', 'in_progress', 'blocked', 'in_review', 'done']

const usage = (message: string): ParsedCommand => ({ kind: 'usage', message })

type OptSpec = Record<string, { type: 'string' | 'boolean'; short?: string }>

interface CommandDef {
  readonly method: ControlMethod
  readonly options: OptSpec
  readonly positionals: readonly string[]
  readonly required: readonly string[]
  readonly stdinField?: StdinField
  readonly build: (
    v: Record<string, string | boolean | undefined>,
    pos: string[]
  ) => Record<string, unknown>
}

const HELP_OPT = { help: { type: 'boolean', short: 'h' } } as const

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined

const COMMANDS: Record<string, CommandDef> = {
  'projects list': {
    method: 'projects.list',
    options: {},
    positionals: [],
    required: [],
    build: () => ({})
  },
  'task create': {
    method: 'task.create',
    options: {
      project: { type: 'string' },
      branch: { type: 'string' },
      'source-branch': { type: 'string' },
      name: { type: 'string' }
    },
    positionals: [],
    required: ['project', 'branch'],
    build: (v) =>
      compact({
        project: str(v.project),
        branch: str(v.branch),
        sourceBranch: str(v['source-branch']),
        name: str(v.name)
      })
  },
  'task list': {
    method: 'task.list',
    options: { project: { type: 'string' } },
    positionals: [],
    required: [],
    build: (v) => compact({ project: str(v.project) })
  },
  'session open': {
    method: 'session.open',
    options: { command: { type: 'string' }, name: { type: 'string' } },
    positionals: ['taskId'],
    required: [],
    stdinField: 'command',
    build: (v, pos) => compact({ taskId: pos[0], command: str(v.command), name: str(v.name) })
  },
  'issues list': {
    method: 'issues.list',
    options: { status: { type: 'string' }, project: { type: 'string' } },
    positionals: [],
    required: [],
    build: (v) => compact({ status: str(v.status), project: str(v.project) })
  },
  'issues get': {
    method: 'issues.get',
    options: { markdown: { type: 'boolean' } },
    positionals: ['issueId'],
    required: [],
    build: (_v, pos) => ({ issueId: pos[0] })
  },
  'issues add': {
    method: 'issues.add',
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      project: { type: 'string' },
      status: { type: 'string' }
    },
    positionals: [],
    required: ['name'],
    stdinField: 'description',
    build: (v) =>
      compact({
        name: str(v.name),
        description: str(v.description) ?? '',
        project: str(v.project),
        status: str(v.status)
      })
  }
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
}

/** Pure: argv (without node/script) → what to do. Never throws. */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const words: string[] = []
  for (const a of argv) {
    if (a.startsWith('-')) break
    words.push(a)
  }
  const wantsHelp = argv.includes('--help') || argv.includes('-h')
  if (words.length === 0) {
    if (wantsHelp || argv.length === 0) return { kind: 'help', text: GLOBAL_HELP }
    return usage(`missing command\n\n${GLOBAL_HELP}`)
  }
  const key = words.slice(0, 2).join(' ')
  const def = COMMANDS[key]
  if (def === undefined) {
    if (
      wantsHelp &&
      words.length === 1 &&
      Object.keys(COMMANDS).some((k) => k.startsWith(words[0] + ' '))
    ) {
      return { kind: 'help', text: GLOBAL_HELP }
    }
    return usage(`unknown command "${words.join(' ')}"; run "octopus-cli --help"`)
  }
  if (wantsHelp) return { kind: 'help', text: helpFor(key) ?? GLOBAL_HELP }

  let values: Record<string, string | boolean | undefined>
  let positionals: string[]
  try {
    const r = parseArgs({
      args: argv.slice(2),
      options: { ...HELP_OPT, ...def.options },
      allowPositionals: true,
      strict: true
    })
    values = r.values as Record<string, string | boolean | undefined>
    positionals = r.positionals
  } catch (e) {
    return usage(`${key}: ${e instanceof Error ? e.message : String(e)}`)
  }
  for (const r of def.required) {
    const val = values[r]
    if (typeof val !== 'string' || val.length === 0) return usage(`${key}: --${r} is required`)
  }
  if (positionals.length < def.positionals.length) {
    return usage(`${key}: missing <${def.positionals[def.positionals.length - 1]}>`)
  }
  if (positionals.length > def.positionals.length) {
    return usage(`${key}: unexpected argument "${positionals[def.positionals.length]}"`)
  }
  const status = str(values.status)
  if (status !== undefined && !STATUSES.includes(status)) {
    return usage(`${key}: --status must be one of ${STATUSES.join(', ')}`)
  }
  const params = def.build(values, positionals)
  const field = def.stdinField
  const wantsStdin = field !== undefined && params[field] === '-'
  return {
    kind: 'call',
    method: def.method,
    params,
    ...(wantsStdin ? { stdinField: field } : {}),
    ...(values.markdown === true ? { output: 'markdown' as const } : {})
  }
}
