import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyHook,
  applyTranscript,
  expireWakes,
  initialFold,
  nextDeadline,
  parseHookLine,
  resolveFold,
  transcriptToTail,
  WAKE_GRACE_MS,
  type ClaudeFold,
  type HookEvent,
  type TranscriptObs
} from './claude-session-fold'
import { parseTranscriptLine } from './claude-transcript'
import { SessionState } from '../../domain/state'

const FIXTURES = join(__dirname, '../../../test/fixtures/claude-state')
const { Unknown, Idle, Working, NeedsInput } = SessionState

const lines = (file: string): string[] =>
  readFileSync(join(FIXTURES, file), 'utf8').split('\n').filter(Boolean)

type Step = { readonly hook: HookEvent } | { readonly obs: TranscriptObs }

/** Fold a step list, returning the de-duplicated state sequence (as the watcher emits). */
function walk(
  steps: readonly Step[],
  f: ClaudeFold = initialFold()
): {
  fold: ClaudeFold
  states: SessionState[]
} {
  const states: SessionState[] = []
  for (const step of steps) {
    const now = 'hook' in step ? step.hook.t : step.obs.ms
    f = 'hook' in step ? applyHook(f, step.hook) : applyTranscript(f, step.obs)
    const { state } = resolveFold(f, now)
    if (states[states.length - 1] !== state) states.push(state)
  }
  return { fold: f, states }
}

/** Test-local builders: every event is the lead's unless `aid` is given. */
let clock = 1_000
const at = (ev: string, extra: Partial<HookEvent> = {}): { hook: HookEvent } => ({
  hook: { ev, t: (clock += 10), sid: 'S', prm: 'p1', ...extra }
})
const ups = (prm: string, extra: Partial<HookEvent> = {}): { hook: HookEvent } =>
  at('UserPromptSubmit', { prm, ...extra })
const bgLaunch = (id: string, prm = 'p1'): Step[] => [
  at('PreToolUse', { prm, tool: 'Agent', tu: `tu-${id}`, ih: `ih-${id}` }),
  at('SubagentStart', { prm, aid: id }),
  at('PostToolUse', { prm, tool: 'Agent', tu: `tu-${id}`, ih: `ih-${id}`, bga: id })
]
const running = (...ids: string[]): HookEvent['bg'] =>
  ids.map((id) => ({ id, ty: 'subagent', st: 'running' }))
const stateAfter = (steps: readonly Step[]): SessionState => {
  const { fold } = walk(steps)
  return resolveFold(fold, clock).state
}

describe('claude session fold — the live trace (2 background agents + 2 permissions)', () => {
  const hooks = lines('trace-2bg-perm.events.jsonl').map((l) => parseHookLine(l)!)
  const obs = lines('transcript-2bg-perm.jsonl')
    .map(parseTranscriptLine)
    .filter((o): o is TranscriptObs => o !== undefined)
  const merged: Step[] = [
    ...hooks.map((hook): [number, Step] => [hook.t, { hook }]),
    ...obs.map((o): [number, Step] => [o.ms, { obs: o }])
  ]
    .sort((a, b) => a[0] - b[0])
    .map(([, step]) => step)

  it('parses every recorded line', () => {
    expect(hooks.every((h) => h !== undefined)).toBe(true)
    expect(obs.map((o) => o.kind)).toEqual([
      'turnEnd',
      'taskNotified',
      'turnEnd',
      'taskNotified',
      'turnEnd',
      'turnEnd',
      'turnEnd',
      'turnEnd'
    ])
  })

  it('emits exactly the expected state sequence', () => {
    expect(walk(merged).states).toEqual([
      Idle, // SessionStart(startup)
      Working, // the delegating prompt …
      Idle, // … held Working across BOTH agents and both task-notification turns
      Working,
      NeedsInput, // permission (approved)
      Working,
      Idle,
      Working,
      NeedsInput, // permission (denied: no hook fires …)
      Idle // … the transcript's interrupt marker ends the turn
    ])
  })

  it('hooks alone (no transcript) differ only in the denied turn staying NeedsInput', () => {
    const { states } = walk(hooks.map((hook) => ({ hook })))
    expect(states).toEqual([
      Idle,
      Working,
      Idle,
      Working,
      NeedsInput,
      Working,
      Idle,
      Working,
      NeedsInput
    ])
  })

  it('bug 1: the first agent finishing does not read done while its sibling runs', () => {
    const firstStop = hooks.findIndex((h) => h.ev === 'SubagentStop')
    const upToSecondStop = hooks.slice(
      0,
      hooks.findIndex((h, i) => i > firstStop && h.ev === 'Stop') + 1
    )
    const { fold } = walk(upToSecondStop.map((hook) => ({ hook })))
    const r = resolveFold(fold, upToSecondStop[upToSecondStop.length - 1].t)
    expect(r.state).toBe(Working)
    expect(r.reason).toMatch(/^subagents_running:1/)
  })

  it('bug 2: no Idle between the last SubagentStop and its task-notification turn', () => {
    const lastSubStop = hooks.map((h) => h.ev).lastIndexOf('SubagentStop')
    const { fold } = walk(hooks.slice(0, lastSubStop + 1).map((hook) => ({ hook })))
    const r = resolveFold(fold, hooks[lastSubStop].t + 80)
    expect(r.state).toBe(Working)
    expect(r.reason).toMatch(/^awaiting_task_notification/)
  })

  it('ignores the unknown internal side agents (no SubagentStart) entirely', () => {
    const side = hooks.filter((h) => h.aid === 'afa2f1b4bc927a18f' || h.aid === 'a142a2e78e6dd16c4')
    expect(side.length).toBeGreaterThan(0)
    const { fold } = walk(hooks.map((hook) => ({ hook })))
    expect(Object.keys(fold.roster)).toEqual([])
    expect(Object.keys(fold.pendingWake)).toEqual([])
  })
})

describe('claude session fold — lead turn', () => {
  it('starts Unknown and treats SessionStart as at-rest', () => {
    expect(resolveFold(initialFold(), 0).state).toBe(Unknown)
    expect(stateAfter([at('SessionStart', { src: 'startup' })])).toBe(Idle)
    expect(stateAfter([at('SessionStart', { src: 'resume' })])).toBe(Idle)
  })

  it('prompt → Working, Stop → Idle, StopFailure → Idle', () => {
    expect(
      walk([ups('p1'), at('PreToolUse', { tool: 'Bash', tu: 'x' }), at('Stop')]).states
    ).toEqual([Working, Idle])
    expect(stateAfter([ups('p1'), at('StopFailure')])).toBe(Idle)
  })

  it('a finished turn does not revive on a stray event with no new prompt', () => {
    const base = [ups('p1'), at('Stop')]
    expect(stateAfter([...base, at('PreToolUse', { prm: 'old', tool: 'Bash', tu: 'y' })])).toBe(
      Idle
    )
    expect(stateAfter([...base, at('SubagentStop', { aid: 'ghost' })])).toBe(Idle)
    expect(stateAfter([...base, at('PermissionRequest', { prm: 'old', tool: 'Bash' })])).toBe(Idle)
    expect(stateAfter([...base, at('PostToolUse', { prm: 'old', tool: 'Bash', tu: 'z' })])).toBe(
      Idle
    )
  })

  it('a same-prompt continuation (user Stop hook) does revive the turn', () => {
    expect(
      walk([ups('p1'), at('Stop'), at('PreToolUse', { tool: 'Bash', tu: 'c' })]).states
    ).toEqual([Working, Idle, Working])
  })

  it('an Esc mid-tool (PostToolUseFailure is_interrupt) ends the turn', () => {
    expect(
      stateAfter([
        ups('p1'),
        at('PreToolUse', { tool: 'Bash', tu: 'b' }),
        at('PostToolUseFailure', { tool: 'Bash', tu: 'b', intr: true })
      ])
    ).toBe(Idle)
    expect(
      stateAfter([
        ups('p1'),
        at('PreToolUse', { tool: 'Bash', tu: 'b' }),
        at('PostToolUseFailure', { tool: 'Bash', tu: 'b' })
      ])
    ).toBe(Working)
  })

  it('a transcript turn end closes an open turn (Esc / denial fire no Stop)', () => {
    const steps: Step[] = [ups('p1'), at('PreToolUse', { tool: 'Bash', tu: 'b' })]
    expect(stateAfter([...steps, { obs: { kind: 'turnEnd', ms: (clock += 10) } }])).toBe(Idle)
  })

  it('a transcript turn end OLDER than the current turn start is ignored', () => {
    const steps: Step[] = [ups('p1')]
    const old = clock - 5
    expect(stateAfter([...steps, { obs: { kind: 'turnEnd', ms: old } }])).toBe(Working)
  })

  it('an interrupt marker of another prompt does not close this turn', () => {
    const steps: Step[] = [ups('p2', { prm: 'p2' })]
    expect(stateAfter([...steps, { obs: { kind: 'turnEnd', ms: (clock += 10), prm: 'p1' } }])).toBe(
      Working
    )
  })

  it('SessionEnd → Unknown (no icon), except /clear which is followed by SessionStart', () => {
    expect(
      stateAfter([ups('p1'), at('Stop'), at('SessionEnd', { rsn: 'prompt_input_exit' })])
    ).toBe(Unknown)
    expect(
      walk([
        ups('p1'),
        at('Stop'),
        at('SessionEnd', { rsn: 'clear' }),
        at('SessionStart', { src: 'clear' })
      ]).states
    ).toEqual([Working, Idle])
  })

  it('a compact SessionStart changes nothing', () => {
    expect(stateAfter([ups('p1'), at('SessionStart', { src: 'compact' })])).toBe(Working)
  })
})

describe('claude session fold — Needs input', () => {
  it('a permission request is NeedsInput until its tool completes', () => {
    const steps: Step[] = [
      ups('p1'),
      at('PreToolUse', { tool: 'Bash', tu: 't1', ih: 'h1' }),
      at('PermissionRequest', { tool: 'Bash', ih: 'h1' })
    ]
    expect(stateAfter(steps)).toBe(NeedsInput)
    expect(stateAfter([...steps, at('PostToolUse', { tool: 'Bash', tu: 't1', ih: 'h1' })])).toBe(
      Working
    )
  })

  it('a parallel tool call completing does not release another tool’s permission wait', () => {
    expect(
      stateAfter([
        ups('p1'),
        at('PreToolUse', { tool: 'Bash', tu: 't1', ih: 'h1' }),
        at('PreToolUse', { tool: 'Read', tu: 't2', ih: 'h2' }),
        at('PermissionRequest', { tool: 'Bash', ih: 'h1' }),
        at('PostToolUse', { tool: 'Read', tu: 't2', ih: 'h2' })
      ])
    ).toBe(NeedsInput)
  })

  it('AskUserQuestion is NeedsInput until answered', () => {
    const steps: Step[] = [
      ups('p1'),
      at('PreToolUse', { tool: 'AskUserQuestion', tu: 'q', ih: 'hq' })
    ]
    expect(stateAfter(steps)).toBe(NeedsInput)
    expect(
      stateAfter([...steps, at('PostToolUse', { tool: 'AskUserQuestion', tu: 'q', ih: 'hq' })])
    ).toBe(Working)
  })

  it('a wait is dropped by the next prompt, a Stop, or a transcript turn end', () => {
    const steps: Step[] = [
      ups('p1'),
      at('PreToolUse', { tool: 'Bash', tu: 't1', ih: 'h1' }),
      at('PermissionRequest', { tool: 'Bash', ih: 'h1' })
    ]
    expect(stateAfter([...steps, ups('p2')])).toBe(Working)
    expect(stateAfter([...steps, at('Stop')])).toBe(Idle)
    expect(stateAfter([...steps, { obs: { kind: 'turnEnd', ms: (clock += 10), prm: 'p1' } }])).toBe(
      Idle
    )
  })

  it('Needs input wins over running background agents', () => {
    expect(
      stateAfter([
        ups('p1'),
        ...bgLaunch('A'),
        at('Stop', { bg: running('A') }),
        ups('p2'),
        at('PreToolUse', { prm: 'p2', tool: 'Bash', tu: 't1', ih: 'h1' }),
        at('PermissionRequest', { prm: 'p2', tool: 'Bash', ih: 'h1' })
      ])
    ).toBe(NeedsInput)
  })

  it('a subagent’s permission request is NeedsInput until that subagent moves on', () => {
    const steps: Step[] = [
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      at('PreToolUse', { aid: 'A', tool: 'Bash', tu: 'c1', ih: 'hc' }),
      at('PermissionRequest', { aid: 'A', tool: 'Bash', ih: 'hc' })
    ]
    expect(stateAfter(steps)).toBe(NeedsInput)
    expect(
      stateAfter([...steps, at('PostToolUse', { aid: 'A', tool: 'Bash', tu: 'c1', ih: 'hc' })])
    ).toBe(Working)
    expect(stateAfter([...steps, at('SubagentStop', { aid: 'A' })])).toBe(Working) // awaiting wake
  })

  it('an unattributed request after the lead finished is held by a running child', () => {
    const steps: Step[] = [
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      at('PreToolUse', { aid: 'A', tool: 'Bash', tu: 'c1', ih: 'hc' }),
      at('PermissionRequest', { tool: 'Bash', ih: 'hc' })
    ]
    expect(stateAfter(steps)).toBe(NeedsInput)
    expect(
      stateAfter([...steps, at('PostToolUse', { aid: 'A', tool: 'Bash', tu: 'c1', ih: 'hc' })])
    ).toBe(Working)
  })

  it('a late lead turn_duration does not clear a running child’s unattributed request', () => {
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      at('PreToolUse', { aid: 'A', tool: 'Bash', tu: 'c1', ih: 'hc' }),
      at('PermissionRequest', { tool: 'Bash', ih: 'hc' })
    ])
    expect(transcriptToTail({ ...fold, transcriptPath: '/t' })).toBeUndefined()
    const late = applyTranscript(fold, { kind: 'turnEnd', ms: clock, prm: 'p1' })
    expect(late).toBe(fold)
    expect(resolveFold(late, clock).state).toBe(NeedsInput)
  })

  it('a foreground child’s request without agent_id is held by the child that has the call open', () => {
    const steps: Step[] = [
      ups('p1'),
      at('PreToolUse', { tool: 'Agent', tu: 'ta', ih: 'ha' }),
      at('SubagentStart', { aid: 'F' }),
      at('PreToolUse', { aid: 'F', tool: 'Bash', tu: 'f1', ih: 'hf' }),
      at('PermissionRequest', { tool: 'Bash', ih: 'hf' })
    ]
    const { fold } = walk(steps)
    expect(fold.waits.map((w) => [w.holder, w.tu])).toEqual([['F', 'f1']])
    expect(resolveFold(fold, clock).state).toBe(NeedsInput)
    expect(
      stateAfter([...steps, at('PostToolUse', { aid: 'F', tool: 'Bash', tu: 'f1', ih: 'hf' })])
    ).toBe(Working)
  })
})

describe('claude session fold — subagents', () => {
  it('a foreground subagent keeps the lead turn Working and leaves nothing behind', () => {
    const { fold, states } = walk([
      ups('p1'),
      at('PreToolUse', { tool: 'Agent', tu: 'ta', ih: 'ha' }),
      at('SubagentStart', { aid: 'F' }),
      at('PreToolUse', { aid: 'F', tool: 'Bash', tu: 'f1' }),
      at('SubagentStop', { aid: 'F' }),
      at('PostToolUse', { tool: 'Agent', tu: 'ta', ih: 'ha', fga: 'F' }),
      at('Stop', { bg: [] })
    ])
    expect(states).toEqual([Working, Idle])
    expect(fold.pendingWake).toEqual({})
  })

  it('fire-and-forget: Working until the agent’s result is picked up, then Idle', () => {
    const steps: Step[] = [
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      at('SubagentStop', { aid: 'A' })
    ]
    expect(stateAfter(steps)).toBe(Working)
    expect(
      walk([...steps, ups('p2', { tn: 'A' }), at('Stop', { prm: 'p2', bg: [] })]).states
    ).toEqual([Working, Idle])
  })

  it('a wake that never comes degrades to Idle after the grace', () => {
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      at('SubagentStop', { aid: 'A' })
    ])
    const stoppedAt = fold.pendingWake.A
    expect(nextDeadline(fold, stoppedAt)).toBe(stoppedAt + WAKE_GRACE_MS)
    expect(resolveFold(fold, stoppedAt + WAKE_GRACE_MS - 1).state).toBe(Working)
    expect(resolveFold(fold, stoppedAt + WAKE_GRACE_MS).state).toBe(Idle)
    expect(nextDeadline(fold, stoppedAt + WAKE_GRACE_MS)).toBeUndefined()
    expect(expireWakes(fold, stoppedAt + WAKE_GRACE_MS - 1)).toBe(fold)
    expect(expireWakes(fold, stoppedAt + WAKE_GRACE_MS).pendingWake).toEqual({})
  })

  it('a wake that never came does not hold later turns Working', () => {
    const steps: Step[] = [
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      at('SubagentStop', { aid: 'A' })
    ]
    clock += WAKE_GRACE_MS
    const done = { id: 'A', ty: 'subagent', st: 'completed' }
    const { fold, states } = walk([
      ...steps,
      ups('p2'),
      at('Stop', { prm: 'p2', bg: [done] }),
      ups('p3'),
      at('Stop', { prm: 'p3', bg: [done] })
    ])
    expect(states).toEqual([Working, Idle, Working, Idle])
    expect(fold.pendingWake).toEqual({})
    expect(nextDeadline(fold, clock)).toBeUndefined()
  })

  it('the wake grace does not run out while the lead is mid-turn', () => {
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      ups('p2'),
      at('SubagentStop', { aid: 'A' }),
      at('PreToolUse', {
        prm: 'p2',
        tool: 'Bash',
        tu: 'b',
        ih: 'hb',
        t: (clock += 3 * WAKE_GRACE_MS)
      }),
      at('PostToolUse', { prm: 'p2', tool: 'Bash', tu: 'b', ih: 'hb' }),
      at('Stop', { prm: 'p2', bg: [] })
    ])
    // A finished while the lead was busy: Claude hands its result over after this turn.
    expect(Object.keys(fold.pendingWake)).toEqual(['A'])
    expect(resolveFold(fold, clock).state).toBe(Working)
  })

  it('the transcript’s task-notification record (written before the hook) opens the wake turn', () => {
    const { fold, states } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      at('SubagentStop', { aid: 'A' }),
      { obs: { kind: 'taskNotified', ms: (clock += 10), id: 'A' } },
      ups('p2', { tn: 'A' }),
      at('Stop', { prm: 'p2', bg: [] })
    ])
    expect(fold.pendingWake).toEqual({})
    expect(states).toEqual([Working, Idle])
  })

  it('a task-notification record for an agent that is not pending changes nothing', () => {
    const f = walk([ups('p1'), at('Stop', { bg: [] })]).fold
    expect(applyTranscript(f, { kind: 'taskNotified', ms: clock + 1, id: 'A' })).toBe(f)
  })

  it('the task-notification prompt never resets the sibling roster (bug 1)', () => {
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      ...bgLaunch('B'),
      at('Stop', { bg: running('A', 'B') }),
      at('SubagentStop', { aid: 'A', bg: running('A', 'B') }),
      ups('p2', { tn: 'A' }),
      at('Stop', { prm: 'p2', bg: running('B') })
    ])
    expect(Object.keys(fold.roster)).toEqual(['B'])
    expect(resolveFold(fold, clock).state).toBe(Working)
  })

  it('a duplicate or unknown SubagentStop cannot cancel a live agent', () => {
    expect(
      stateAfter([
        ups('p1'),
        ...bgLaunch('A'),
        at('Stop', { bg: running('A') }),
        at('SubagentStop', { aid: 'ghost' }),
        at('PreToolUse', { aid: 'side', tool: 'Bash', tu: 's' })
      ])
    ).toBe(Working)
  })

  it('a child event for an id never started does not create a roster entry', () => {
    expect(
      stateAfter([ups('p1'), at('Stop'), at('PreToolUse', { aid: 'side', tool: 'Bash', tu: 's' })])
    ).toBe(Idle)
  })

  it('the lead Stop inventory reaps an agent whose SubagentStop never came', () => {
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      ups('p2'),
      at('Stop', { prm: 'p2', bg: [] })
    ])
    expect(fold.roster).toEqual({})
    // It was a background agent, so its result may still be on the way.
    expect(resolveFold(fold, clock).state).toBe(Working)
    expect(resolveFold(fold, clock + WAKE_GRACE_MS).state).toBe(Idle)
  })

  it('the lead Stop inventory re-adds a running subagent and ignores shells', () => {
    const { fold } = walk([
      ups('p1'),
      at('Stop', {
        bg: [
          { id: 'X', ty: 'subagent', st: 'running' },
          { id: 'sh', ty: 'bash', st: 'running' }
        ]
      })
    ])
    expect(Object.keys(fold.roster)).toEqual(['X'])
  })

  it('turn_duration with no pending background agents clears the roster (Esc killed them)', () => {
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      { obs: { kind: 'turnEnd', ms: (clock += 10), pendingBg: 0 } }
    ])
    expect(resolveFold(fold, clock).state).toBe(Idle)
  })

  it('turn_duration with no pending agents keeps a finished agent’s pending wake-up', () => {
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      at('SubagentStop', { aid: 'A' }),
      { obs: { kind: 'turnEnd', ms: (clock += 10), pendingBg: 0 } }
    ])
    expect(resolveFold(fold, clock).state).toBe(Working)
    expect(resolveFold(fold, clock + WAKE_GRACE_MS).state).toBe(Idle)
  })

  it('a resumed agent (same id) is re-admitted; its stale notification is ignored', () => {
    const notifiedAt = (clock += 10)
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      at('SubagentStop', { aid: 'A' }),
      ups('p2', { tn: 'A' }),
      at('PreToolUse', { prm: 'p2', tool: 'SendMessage', tu: 'sm' }),
      at('SubagentStart', { prm: 'p2', aid: 'A' }),
      { obs: { kind: 'taskNotified', ms: notifiedAt, id: 'A' } },
      at('Stop', { prm: 'p2', bg: running('A') })
    ])
    expect(Object.keys(fold.roster)).toEqual(['A'])
    expect(resolveFold(fold, clock).state).toBe(Working)
  })
})

describe('claude session fold — conversations', () => {
  it('a new conversation id via a prompt resets the roster', () => {
    const { fold } = walk([
      ups('p1'),
      ...bgLaunch('A'),
      at('Stop', { bg: running('A') }),
      ups('q1', { sid: 'S2' })
    ])
    expect(fold.sid).toBe('S2')
    expect(fold.roster).toEqual({})
  })

  it('events of a replaced conversation (other than a boundary) are ignored', () => {
    const steps: Step[] = [ups('p1'), at('Stop'), at('SessionStart', { sid: 'S2', src: 'clear' })]
    expect(stateAfter([...steps, at('PreToolUse', { sid: 'S', tool: 'Bash', tu: 'o' })])).toBe(Idle)
    expect(stateAfter([...steps, at('SubagentStart', { sid: 'S', aid: 'old' })])).toBe(Idle)
  })
})

describe('claude session fold — tailing + parsing', () => {
  it('tails the transcript only while a lead turn is open or waiting', () => {
    const tp = '/t.jsonl'
    expect(transcriptToTail(walk([ups('p1', { tp })]).fold)).toBe(tp)
    expect(transcriptToTail(walk([ups('p1', { tp }), at('Stop')]).fold)).toBeUndefined()
  })

  it('rejects malformed hook lines', () => {
    expect(parseHookLine('not json')).toBeUndefined()
    expect(parseHookLine('{"ev":"Stop"}')).toBeUndefined()
    expect(parseHookLine('[1]')).toBeUndefined()
    expect(parseHookLine('{"ev":"Stop","t":5,"bg":[{"id":"a","ty":"subagent"},7]}')?.bg).toEqual([
      { id: 'a', ty: 'subagent', st: undefined }
    ])
  })

  it('ignores event types it does not know (e.g. a legacy Notification line)', () => {
    const f = walk([ups('p1')]).fold
    expect(applyHook(f, { ev: 'Notification', t: clock + 1, sid: 'S' })).toBe(f)
  })
})
