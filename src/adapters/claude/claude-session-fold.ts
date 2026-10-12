/**
 * The pure Claude session-state fold (DESIGN §9.3). The python hook only RECORDS —
 * it appends one trimmed line per Claude hook to `<sessionId>.events.jsonl` — and
 * ALL state logic lives here, app-side, as a deterministic reducer over that log plus
 * a few observations tailed from Claude's own transcript. `resolveFold` turns the
 * folded facts into the one {@link SessionState} the rest of the app consumes.
 *
 * ## What is tracked (per Octopus session)
 *   - the LEAD agent's phase (events with no `agent_id` are the lead's): `working`
 *     from a prompt/tool event, `done` from Stop / a transcript turn end;
 *   - a ROSTER of running subagents: SubagentStart adds, SubagentStop removes, and the
 *     lead Stop's `background_tasks` inventory is authoritative (reaps / re-adds). A
 *     child-attributed tool event for an id the roster doesn't hold NEVER creates an
 *     entry — Claude runs internal side agents that emit tool hooks with no
 *     SubagentStart/Stop, and admitting them would stick the session on Working;
 *   - `pendingWake`: background agents that finished but whose result Claude has not
 *     picked up yet. When a background agent stops, the harness wakes the lead with a
 *     `<task-notification>` prompt ~80 ms later, which opens a new lead turn. Holding
 *     Working across that gap is what prevents the done-then-working flicker; only the
 *     matching `<task-notification>` (or a transcript record of it) clears the entry,
 *     and a wake that never comes degrades to Idle after {@link WAKE_GRACE_MS} of the
 *     lead being at rest (then the entry is dropped for good);
 *   - WAITS (Needs input): a permission request, or an AskUserQuestion, held by the
 *     lead or by a subagent, released by the matching tool completion.
 *
 * A UserPromptSubmit NEVER resets the roster: the harness-injected task-notification
 * prompt arrives while sibling agents are still running.
 *
 * ## Time
 * Hook `t` is epoch ms taken by the python appender; transcript `ms` is the record's
 * ISO timestamp. Same host clock. A transcript turn end only counts when it is not
 * older than the current lead turn's start, so a lagging tail can never close a newer
 * turn (Claude writes `turn_duration(N)` before the user record of turn N+1, which in
 * turn precedes its UserPromptSubmit hook).
 */

import { SessionState } from '../../domain/state'

/** How long a finished background agent may wait for Claude to pick up its result. */
export const WAKE_GRACE_MS = 10_000

/** One `background_tasks` entry as recorded by the appender. */
export interface BgTask {
  readonly id: string
  /** Task type (`subagent`, `bash`, ...). Only subagents hold the session Working. */
  readonly ty?: string
  /** Status (`running`, `completed`, ...). */
  readonly st?: string
}

/** One recorded hook event (a line of `<sessionId>.events.jsonl`). */
export interface HookEvent {
  readonly ev: string
  /** Epoch ms when the hook ran. */
  readonly t: number
  /** Claude conversation id (`session_id`). */
  readonly sid?: string
  /** Subagent id; absent ⇒ the event is the lead agent's. */
  readonly aid?: string
  /** Claude `prompt_id` — the lead turn the event belongs to. */
  readonly prm?: string
  /** SessionStart `source`. */
  readonly src?: string
  /** SessionEnd `reason`. */
  readonly rsn?: string
  /** Transcript path. */
  readonly tp?: string
  /** UserPromptSubmit: the task id of a harness `<task-notification>` prompt. */
  readonly tn?: string
  readonly tool?: string
  /** `tool_use_id`. */
  readonly tu?: string
  /** Short hash of the canonical `tool_input` (correlates PermissionRequest ↔ tool). */
  readonly ih?: string
  /** PostToolUse(Agent|Task) of a BACKGROUND launch: the launched agent id. */
  readonly bga?: string
  /** PostToolUse(Agent|Task) of a FOREGROUND run: the finished agent id. */
  readonly fga?: string
  /** `background_tasks` (Stop / SubagentStop). */
  readonly bg?: readonly BgTask[]
  /** `is_interrupt` (PostToolUseFailure / Stop). */
  readonly intr?: boolean
}

/** A fact read from Claude's transcript. */
export type TranscriptObs =
  /** The lead turn ended (`turn_duration`, or an interrupt / denied-permission marker). */
  | {
      readonly kind: 'turnEnd'
      readonly ms: number
      readonly prm?: string
      /** `pendingBackgroundAgentCount` of a `turn_duration` (absent there ⇒ 0). */
      readonly pendingBg?: number
    }
  /** Claude consumed a background agent's `<task-notification>`. */
  | { readonly kind: 'taskNotified'; readonly ms: number; readonly id: string }

/** Who holds a wait: the lead, a subagent id, or unattributed (a child request without id). */
const LEAD = 'lead'
const UNATTRIBUTED = '?'

export interface Wait {
  readonly holder: string
  readonly kind: 'permission' | 'question'
  readonly tool?: string
  readonly tu?: string
  readonly ih?: string
}

interface OpenTool {
  readonly holder: string
  readonly tu: string
  readonly tool?: string
  readonly ih?: string
}

export type LeadPhase = 'none' | 'working' | 'done' | 'ended'

export interface ClaudeFold {
  readonly sid?: string
  readonly phase: LeadPhase
  /** prompt_id of the current / last lead turn. */
  readonly prm?: string
  readonly turnStartMs: number
  readonly lastDoneMs: number
  readonly transcriptPath?: string
  /** Running subagent id → since (ms). */
  readonly roster: Readonly<Record<string, number>>
  /** Ids known to be background agents. */
  readonly bgAgents: readonly string[]
  /** Finished background agent id → when it finished (ms). */
  readonly pendingWake: Readonly<Record<string, number>>
  /** Ids whose task-notification was consumed or given up on (re-admitted only by SubagentStart). */
  readonly woken: readonly string[]
  readonly waits: readonly Wait[]
  readonly openTools: readonly OpenTool[]
  readonly lastEv?: string
}

const CAP_IDS = 256
const CAP_OPEN_TOOLS = 32
const QUESTION_TOOL = 'AskUserQuestion'

/** Background-task statuses that mean the task is over (mirrors Orca's inventory). */
const TERMINAL_STATUSES = new Set([
  'idle',
  'done',
  'success',
  'succeeded',
  'complete',
  'completed',
  'finished',
  'failed',
  'error',
  'terminated',
  'exited',
  'aborted',
  'expired',
  'skipped',
  'crashed',
  'killed',
  'cancelled',
  'canceled',
  'timed_out'
])

export function initialFold(): ClaudeFold {
  return {
    phase: 'none',
    turnStartMs: 0,
    lastDoneMs: 0,
    roster: {},
    bgAgents: [],
    pendingWake: {},
    woken: [],
    waits: [],
    openTools: []
  }
}

/** Mutable working copy used inside one transition. */
interface Draft {
  sid?: string
  phase: LeadPhase
  prm?: string
  turnStartMs: number
  lastDoneMs: number
  transcriptPath?: string
  roster: Record<string, number>
  bgAgents: string[]
  pendingWake: Record<string, number>
  woken: string[]
  waits: Wait[]
  openTools: OpenTool[]
  lastEv?: string
}

function draft(f: ClaudeFold): Draft {
  return {
    ...f,
    roster: { ...f.roster },
    bgAgents: [...f.bgAgents],
    pendingWake: { ...f.pendingWake },
    woken: [...f.woken],
    waits: [...f.waits],
    openTools: [...f.openTools]
  }
}

function pushCapped(list: string[], id: string): void {
  if (list.includes(id)) return
  list.push(id)
  if (list.length > CAP_IDS) list.shift()
}

const isLeadSide = (holder: string): boolean => holder === LEAD || holder === UNATTRIBUTED

function clearLeadTurn(d: Draft): void {
  d.waits = d.waits.filter((w) => !isLeadSide(w.holder))
  d.openTools = d.openTools.filter((o) => o.holder !== LEAD)
}

function forgetAgent(d: Draft, id: string): void {
  delete d.roster[id]
  d.waits = d.waits.filter((w) => w.holder !== id)
  d.openTools = d.openTools.filter((o) => o.holder !== id)
}

function markWoken(d: Draft, id: string): void {
  forgetAgent(d, id)
  delete d.pendingWake[id]
  pushCapped(d.woken, id)
}

/**
 * Give up on finished background agents whose wake grace ran out while the lead was at
 * rest — their result is not coming. Otherwise every later Stop (which moves
 * `lastDoneMs`) would re-arm the grace and hold Working for another 10 s each turn.
 * They join `woken` so a later inventory still listing them as completed can't re-add
 * them. The grace only runs while the lead is done: a lead turn in progress delays the
 * wake-up, it doesn't use it up.
 */
function dropExpiredWakes(d: Draft, nowMs: number): boolean {
  if (d.phase !== 'done') return false
  let dropped = false
  for (const [id, since] of Object.entries(d.pendingWake)) {
    if (Math.max(since, d.lastDoneMs) + WAKE_GRACE_MS > nowMs) continue
    delete d.pendingWake[id]
    pushCapped(d.woken, id)
    dropped = true
  }
  return dropped
}

/** Apply wake-grace expiry at `nowMs` (the watcher's timer). Returns `f` if nothing expired. */
export function expireWakes(f: ClaudeFold, nowMs: number): ClaudeFold {
  const d = draft(f)
  return dropExpiredWakes(d, nowMs) ? d : f
}

/** A wait is released by the completion of the tool it is about. */
function matchesWait(w: Wait, e: HookEvent): boolean {
  if (w.tu !== undefined) return w.tu === e.tu
  return w.tool === e.tool && w.ih === e.ih
}

function addWait(d: Draft, w: Wait): void {
  const key = (x: Wait): string => `${x.holder}|${x.tu ?? `${x.tool}:${x.ih}`}`
  if (d.waits.some((x) => key(x) === key(w))) return
  d.waits.push(w)
}

function openTool(d: Draft, holder: string, e: HookEvent): void {
  if (e.tu === undefined) return
  d.openTools = d.openTools.filter((o) => o.tu !== e.tu)
  d.openTools.push({ holder, tu: e.tu, tool: e.tool, ih: e.ih })
  if (d.openTools.length > CAP_OPEN_TOOLS) d.openTools.shift()
}

function closeTool(d: Draft, e: HookEvent): void {
  if (e.tu !== undefined) d.openTools = d.openTools.filter((o) => o.tu !== e.tu)
}

/** Forget everything tied to the previous Claude conversation. */
function resetConversation(d: Draft, sid: string | undefined): void {
  d.sid = sid
  d.prm = undefined
  d.roster = {}
  d.bgAgents = []
  d.pendingWake = {}
  d.woken = []
  d.waits = []
  d.openTools = []
}

/**
 * Which Claude conversation the log is about. A different `session_id` is adopted
 * only on a lead SessionStart (startup / resume / clear) or a lead prompt — a new
 * conversation in this terminal. Anything else from a foreign id (e.g. a background
 * agent of the conversation `/clear` just replaced) is ignored. A nested `claude -p`
 * started from inside the session is filtered out by the hook itself.
 */
function admit(d: Draft, e: HookEvent): boolean {
  if (e.sid === undefined || e.sid === d.sid) return true
  if (d.sid === undefined) {
    d.sid = e.sid
    return true
  }
  const lead = e.aid === undefined
  const boundary = (e.ev === 'SessionStart' && e.src !== 'compact') || e.ev === 'UserPromptSubmit'
  if (!lead || !boundary) return false
  resetConversation(d, e.sid)
  return true
}

/**
 * Whether a lead tool event may (re)open the lead turn. Once a turn is done, only an
 * event of the SAME prompt (a Stop-hook continuation) revives it — a stray late event
 * must never flip a finished session back to Working (PRD "must not revive").
 */
function admitLeadActivity(d: Draft, e: HookEvent): boolean {
  if (d.phase === 'working') return true
  if (d.phase === 'none') {
    d.prm ??= e.prm
    d.turnStartMs = e.t
    return true
  }
  return e.prm !== undefined && e.prm === d.prm
}

function isRunningStatus(st: string | undefined): boolean {
  return st === undefined || !TERMINAL_STATUSES.has(st.toLowerCase())
}

/** Reconcile the roster with a lead Stop's authoritative `background_tasks`. */
function reconcileInventory(d: Draft, bg: readonly BgTask[], t: number): void {
  const running = new Set<string>()
  for (const task of bg) {
    if (task.ty !== 'subagent') continue
    if (d.woken.includes(task.id) && !(task.id in d.roster)) continue
    if (isRunningStatus(task.st)) {
      running.add(task.id)
      d.roster[task.id] ??= t
      pushCapped(d.bgAgents, task.id)
    } else {
      d.pendingWake[task.id] ??= t
    }
  }
  for (const id of Object.keys(d.roster)) {
    if (running.has(id)) continue
    forgetAgent(d, id)
    if (d.bgAgents.includes(id)) d.pendingWake[id] ??= t
  }
}

/** Fold one hook event. Returns `f` itself when the event is ignored. */
export function applyHook(f: ClaudeFold, e: HookEvent): ClaudeFold {
  const d = draft(f)
  if (!admit(d, e)) return f
  dropExpiredWakes(d, e.t)
  const lead = e.aid === undefined
  const aid = e.aid

  switch (e.ev) {
    case 'SessionStart': {
      if (!lead || e.src === 'compact') return f
      // A new / resumed / cleared conversation is at rest at its prompt.
      resetConversation(d, d.sid)
      d.phase = 'done'
      d.turnStartMs = e.t
      d.lastDoneMs = e.t
      d.transcriptPath = e.tp ?? d.transcriptPath
      break
    }
    case 'SessionEnd': {
      // `/clear` ends the old conversation and SessionStart(clear) follows at once —
      // reporting Unknown in between would only blink the icon.
      if (!lead || e.rsn === 'clear') return f
      resetConversation(d, d.sid)
      d.phase = 'ended'
      break
    }
    case 'UserPromptSubmit': {
      if (!lead) return f
      if (e.tn !== undefined) markWoken(d, e.tn)
      clearLeadTurn(d)
      d.phase = 'working'
      d.turnStartMs = e.t
      d.prm = e.prm
      d.transcriptPath = e.tp ?? d.transcriptPath
      break
    }
    case 'PreToolUse': {
      if (lead) {
        if (!admitLeadActivity(d, e)) return f
        d.phase = 'working'
        openTool(d, LEAD, e)
        if (e.tool === QUESTION_TOOL) {
          addWait(d, { holder: LEAD, kind: 'question', tool: e.tool, tu: e.tu, ih: e.ih })
        }
      } else if (aid !== undefined && aid in d.roster) {
        // The child moved on, so whatever it was blocked on is resolved.
        d.waits = d.waits.filter((w) => w.holder !== aid)
        openTool(d, aid, e)
      } else {
        return f
      }
      break
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (lead) {
        if (!admitLeadActivity(d, e)) return f
        closeTool(d, e)
        d.waits = d.waits.filter((w) => !(isLeadSide(w.holder) && matchesWait(w, e)))
        if (e.bga !== undefined && !d.woken.includes(e.bga)) {
          pushCapped(d.bgAgents, e.bga)
          d.roster[e.bga] ??= e.t
        }
        if (e.fga !== undefined) {
          delete d.roster[e.fga]
          delete d.pendingWake[e.fga]
        }
        if (e.ev === 'PostToolUseFailure' && e.intr === true) {
          // Esc mid-tool: the lead turn is over.
          clearLeadTurn(d)
          d.phase = 'done'
          d.lastDoneMs = e.t
        } else {
          d.phase = 'working'
        }
      } else {
        const known = aid !== undefined && aid in d.roster
        const before = d.waits.length
        d.waits = d.waits.filter(
          (w) => !((w.holder === aid && known) || (w.holder === UNATTRIBUTED && matchesWait(w, e)))
        )
        if (!known && d.waits.length === before) return f
        if (known) closeTool(d, e)
      }
      break
    }
    case 'PermissionRequest': {
      let holder: string
      if (!lead && aid !== undefined) {
        const plausible =
          aid in d.roster || d.phase === 'working' || Object.keys(d.roster).length > 0
        if (!plausible) return f
        holder = aid
      } else if (d.phase === 'working' || d.phase === 'none') {
        // Normally the lead's — but if this exact call is open in a running child (a
        // foreground subagent's request may lack agent_id), it's that child's: only
        // the child's own next tool event can release it.
        const owner = [...d.openTools]
          .reverse()
          .find((o) => o.tool === e.tool && o.ih === e.ih)?.holder
        holder = owner !== undefined && owner in d.roster ? owner : LEAD
        if (d.phase === 'none') {
          d.phase = 'working'
          d.turnStartMs = e.t
        }
      } else if (Object.keys(d.roster).length > 0) {
        // The lead is done, so this is most likely a running child's request.
        holder = UNATTRIBUTED
      } else {
        return f // a stray request after a finished turn
      }
      // PermissionRequest carries no tool_use_id: borrow it from the open tool call.
      const open = [...d.openTools]
        .reverse()
        .find(
          (o) =>
            (holder === UNATTRIBUTED || o.holder === holder) && o.tool === e.tool && o.ih === e.ih
        )
      addWait(d, { holder, kind: 'permission', tool: e.tool, tu: open?.tu ?? e.tu, ih: e.ih })
      break
    }
    case 'SubagentStart': {
      if (aid === undefined) return f
      const plausible =
        d.phase === 'working' ||
        d.phase === 'none' ||
        Object.keys(d.roster).length > 0 ||
        (e.prm !== undefined && e.prm === d.prm)
      if (!plausible) return f
      // A RESUMED agent (SendMessage) reuses its id and may notify again: re-admit it.
      d.woken = d.woken.filter((id) => id !== aid)
      d.roster[aid] ??= e.t
      delete d.pendingWake[aid]
      break
    }
    case 'SubagentStop': {
      // Unknown / duplicate / stray stops never touch state.
      if (aid === undefined || !(aid in d.roster)) return f
      forgetAgent(d, aid)
      // SubagentStop's own inventory is a stale snapshot (it still lists this agent as
      // running) — it is only used to recognise the agent as a background one.
      const background = d.bgAgents.includes(aid) || (e.bg ?? []).some((b) => b.id === aid)
      if (background && !d.woken.includes(aid)) d.pendingWake[aid] = e.t
      break
    }
    case 'Stop':
    case 'StopFailure': {
      if (!lead) return f
      clearLeadTurn(d)
      d.phase = 'done'
      d.lastDoneMs = e.t
      if (Array.isArray(e.bg)) reconcileInventory(d, e.bg, e.t)
      break
    }
    default:
      return f // not a state signal (e.g. Notification lines from an older install)
  }
  d.lastEv = e.ev
  return d
}

/** Fold one transcript observation. Returns `f` itself when it changes nothing. */
export function applyTranscript(f: ClaudeFold, o: TranscriptObs): ClaudeFold {
  if (o.kind === 'taskNotified') {
    // Consumption is a fact whenever we read it — unless the agent (re)started after
    // that record (a resumed agent reuses its id), in which case the record is stale.
    const since = f.roster[o.id]
    if (since !== undefined && o.ms < since) return f
    const pending = o.id in f.pendingWake || since !== undefined
    if (!pending) return f
    const d = draft(f)
    markWoken(d, o.id)
    // Claude writes this record ~50 ms BEFORE the wake-up's UserPromptSubmit hook: it IS
    // the start of the lead's new turn, so open it now rather than blink Idle in between.
    if (d.phase === 'done' && o.ms >= d.lastDoneMs) {
      d.phase = 'working'
      d.turnStartMs = o.ms
    }
    d.lastEv = 'transcript:task_notification'
    return d
  }
  if (o.ms < f.turnStartMs) return f
  // Only the lead's own turn: a `?` wait (a child's request after the lead finished)
  // says nothing about the lead transcript, whose late `turn_duration` must not clear it.
  const leadWaiting = f.waits.some((w) => w.holder === LEAD)
  if (f.phase !== 'working' && !leadWaiting) return f
  if (o.prm !== undefined && f.prm !== undefined && o.prm !== f.prm) return f
  const d = draft(f)
  clearLeadTurn(d)
  d.phase = 'done'
  d.lastDoneMs = o.ms
  if (o.pendingBg === 0) {
    // Claude says no background agent is still running (e.g. Esc killed them). Finished
    // agents awaiting their wake-up are kept: whether Claude counts them is unverified,
    // and dropping them would blink Idle before the task-notification turn.
    for (const id of Object.keys(d.roster)) forgetAgent(d, id)
  }
  d.lastEv = 'transcript:turn_end'
  return d
}

function wakeDeadlines(f: ClaudeFold): number[] {
  return Object.values(f.pendingWake).map((since) => Math.max(since, f.lastDoneMs) + WAKE_GRACE_MS)
}

/** Resolve the folded facts to the session's state (+ a reason for the log). */
export function resolveFold(
  f: ClaudeFold,
  nowMs: number
): { readonly state: SessionState; readonly reason: string } {
  const tail = f.lastEv ? ` <- ${f.lastEv}` : ''
  if (f.phase === 'none') return { state: SessionState.Unknown, reason: 'no_signal' }
  if (f.phase === 'ended') return { state: SessionState.Unknown, reason: `session_end${tail}` }
  const wait = f.waits[0]
  if (wait !== undefined) {
    const who = isLeadSide(wait.holder) ? '' : ':subagent'
    return { state: SessionState.NeedsInput, reason: `${wait.kind}${who}${tail}` }
  }
  if (f.phase === 'working') return { state: SessionState.Working, reason: `lead_working${tail}` }
  const running = Object.keys(f.roster).length
  if (running > 0) {
    return { state: SessionState.Working, reason: `subagents_running:${running}${tail}` }
  }
  if (wakeDeadlines(f).some((deadline) => deadline > nowMs)) {
    return { state: SessionState.Working, reason: `awaiting_task_notification${tail}` }
  }
  return { state: SessionState.Idle, reason: `turn_done${tail}` }
}

/** The next instant `resolveFold` could change on its own (a wake grace expiring). */
export function nextDeadline(f: ClaudeFold, nowMs: number): number | undefined {
  const future = wakeDeadlines(f).filter((deadline) => deadline > nowMs)
  return future.length > 0 ? Math.min(...future) : undefined
}

/** The transcript worth tailing now: only while a lead turn is open (or waiting). */
export function transcriptToTail(f: ClaudeFold): string | undefined {
  const open = f.phase === 'working' || f.waits.some((w) => w.holder === LEAD)
  return open ? f.transcriptPath : undefined
}

/** Parse one events-log line; undefined for a malformed / foreign line. */
export function parseHookLine(line: string): HookEvent | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.ev !== 'string' || typeof r.t !== 'number') return undefined
  const str = (k: string): string | undefined =>
    typeof r[k] === 'string' ? (r[k] as string) : undefined
  const bg = Array.isArray(r.bg)
    ? r.bg.flatMap((b): BgTask[] => {
        if (typeof b !== 'object' || b === null) return []
        const x = b as Record<string, unknown>
        if (typeof x.id !== 'string') return []
        return [
          {
            id: x.id,
            ty: typeof x.ty === 'string' ? x.ty : undefined,
            st: typeof x.st === 'string' ? x.st : undefined
          }
        ]
      })
    : undefined
  return {
    ev: r.ev,
    t: r.t,
    sid: str('sid'),
    aid: str('aid'),
    prm: str('prm'),
    src: str('src'),
    rsn: str('rsn'),
    tp: str('tp'),
    tn: str('tn'),
    tool: str('tool'),
    tu: str('tu'),
    ih: str('ih'),
    bga: str('bga'),
    fga: str('fga'),
    bg,
    intr: typeof r.intr === 'boolean' ? r.intr : undefined
  }
}
