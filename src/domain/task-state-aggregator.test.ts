import { describe, it, expect } from 'vitest'
import { worstStatusWins } from './task-state-aggregator'
import { SessionState, TaskState } from './state'

describe('worstStatusWins (DESIGN §3.4)', () => {
  it('returns Unknown for an empty task (no icon)', () => {
    expect(worstStatusWins.aggregate([])).toBe(TaskState.Unknown)
  })

  it('returns Unknown when every session is Unknown — the V1 case', () => {
    expect(
      worstStatusWins.aggregate([SessionState.Unknown, SessionState.Unknown, SessionState.Unknown])
    ).toBe(TaskState.Unknown)
  })

  it('Blocked beats Working, Waiting and Unknown', () => {
    expect(
      worstStatusWins.aggregate([
        SessionState.Unknown,
        SessionState.Idle,
        SessionState.Working,
        SessionState.NeedsInput
      ])
    ).toBe(TaskState.NeedsInput)
  })

  it('Working beats Waiting and Unknown', () => {
    expect(
      worstStatusWins.aggregate([SessionState.Idle, SessionState.Working, SessionState.Unknown])
    ).toBe(TaskState.Working)
  })

  it('Waiting beats Unknown but nothing else present', () => {
    expect(worstStatusWins.aggregate([SessionState.Unknown, SessionState.Idle])).toBe(
      TaskState.Idle
    )
  })

  it('is order-independent (commutative)', () => {
    const a = worstStatusWins.aggregate([SessionState.Working, SessionState.NeedsInput])
    const b = worstStatusWins.aggregate([SessionState.NeedsInput, SessionState.Working])
    expect(a).toBe(b)
    expect(a).toBe(TaskState.NeedsInput)
  })

  it('ignores Unknown sessions when a known state is present (transparency)', () => {
    // A blocked build is not masked by an un-evaluated (Unknown) terminal.
    expect(
      worstStatusWins.aggregate([SessionState.Unknown, SessionState.NeedsInput, SessionState.Unknown])
    ).toBe(TaskState.NeedsInput)
  })
})
