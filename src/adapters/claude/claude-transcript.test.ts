import { describe, it, expect } from 'vitest'
import { parseTranscriptLine } from './claude-transcript'

const TS = '2026-10-12T11:29:02.096Z'
const MS = Date.parse(TS)
const line = (r: Record<string, unknown>): string => JSON.stringify({ timestamp: TS, ...r })

describe('parseTranscriptLine', () => {
  it('reads a lead turn end with its pending background-agent count', () => {
    expect(
      parseTranscriptLine(
        line({ type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 2 })
      )
    ).toEqual({ kind: 'turnEnd', ms: MS, pendingBg: 2 })
    expect(parseTranscriptLine(line({ type: 'system', subtype: 'turn_duration' }))).toEqual({
      kind: 'turnEnd',
      ms: MS,
      pendingBg: 0
    })
  })

  it('reads an interrupt / denied-permission marker as a turn end of its prompt', () => {
    const r = line({
      type: 'user',
      promptId: 'p9',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }]
      }
    })
    expect(parseTranscriptLine(r)).toEqual({ kind: 'turnEnd', ms: MS, prm: 'p9' })
    const plain = line({
      type: 'user',
      message: { role: 'user', content: '[Request interrupted by user]' }
    })
    expect(parseTranscriptLine(plain)).toEqual({ kind: 'turnEnd', ms: MS, prm: undefined })
  })

  it('reads the harness wake-up of the lead as a consumed task notification', () => {
    const r = line({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>a5e5</task-id>\n</task-notification>'
      }
    })
    expect(parseTranscriptLine(r)).toEqual({ kind: 'taskNotified', ms: MS, id: 'a5e5' })
  })

  it('ignores sidechain records, quoted markers and everything else', () => {
    expect(
      parseTranscriptLine(line({ type: 'system', subtype: 'turn_duration', isSidechain: true }))
    ).toBeUndefined()
    // The marker text quoted inside an assistant message is not an interrupt.
    expect(
      parseTranscriptLine(
        line({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }
        })
      )
    ).toBeUndefined()
    expect(
      parseTranscriptLine(
        line({ type: 'user', message: { content: 'please explain <task-notification> tags' } })
      )
    ).toBeUndefined()
    expect(
      parseTranscriptLine(line({ type: 'assistant', message: { content: 'hi' } }))
    ).toBeUndefined()
    expect(parseTranscriptLine('{"type":"system","subtype":"turn_duration"')).toBeUndefined()
    expect(
      parseTranscriptLine(JSON.stringify({ type: 'system', subtype: 'turn_duration' }))
    ).toBeUndefined()
  })
})
