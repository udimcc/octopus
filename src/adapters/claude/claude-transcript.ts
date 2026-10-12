/**
 * Reads the few Claude-transcript facts the session fold needs (DESIGN §9.3). Hooks
 * miss two endings — an Esc interrupt and a DENIED permission fire no Stop — but
 * Claude always writes them to the session transcript:
 *   - every lead turn ends with a `{type:'system', subtype:'turn_duration'}` record
 *     (carrying `pendingBackgroundAgentCount` while background agents still run);
 *   - an interrupt / denial leaves a user record `[Request interrupted by user…]`;
 *   - the harness's wake-up of the lead is a user record whose `origin.kind` is
 *     `task-notification` (content `<task-notification><task-id>…`).
 * Subagent (sidechain) records are ignored: only the lead's turn is read here.
 */

import type { TranscriptObs } from './claude-session-fold'

const INTERRUPT_PREFIX = '[Request interrupted by user'
const TASK_NOTIFICATION = '<task-notification>'
const TASK_ID_RE = /<task-id>\s*([^<\s]{1,128})\s*<\/task-id>/

/** First text of a user message's content (string or `[{type:'text', text}]`). */
function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    if (typeof part === 'object' && part !== null) {
      const p = part as Record<string, unknown>
      if (p.type === 'text' && typeof p.text === 'string') return p.text
    }
  }
  return undefined
}

/** Parse one transcript JSONL line; undefined when it is not a state fact. */
export function parseTranscriptLine(line: string): TranscriptObs | undefined {
  // Cheap prefilter: the vast majority of records are assistant/tool/attachment ones.
  if (
    !line.includes('turn_duration') &&
    !line.includes(INTERRUPT_PREFIX) &&
    !line.includes(TASK_NOTIFICATION)
  ) {
    return undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (r.isSidechain === true || typeof r.timestamp !== 'string') return undefined
  const ms = Date.parse(r.timestamp)
  if (Number.isNaN(ms)) return undefined

  if (r.type === 'system' && r.subtype === 'turn_duration') {
    const pending = r.pendingBackgroundAgentCount
    return { kind: 'turnEnd', ms, pendingBg: typeof pending === 'number' ? pending : 0 }
  }
  if (r.type !== 'user') return undefined
  const message = r.message as Record<string, unknown> | undefined
  const text = userText(message?.content)
  if (text === undefined) return undefined
  const prm = typeof r.promptId === 'string' ? r.promptId : undefined
  if (text.startsWith(INTERRUPT_PREFIX)) return { kind: 'turnEnd', ms, prm }
  const origin = r.origin as Record<string, unknown> | undefined
  if (origin?.kind === 'task-notification' || text.trimStart().startsWith(TASK_NOTIFICATION)) {
    const id = TASK_ID_RE.exec(text)?.[1]
    if (id !== undefined) return { kind: 'taskNotified', ms, id }
  }
  return undefined
}
