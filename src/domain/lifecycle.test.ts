import { describe, it, expect } from 'vitest'
import {
  TaskLifecycle,
  SessionLifecycle,
  canTransitionTask,
  canTransitionSession,
  lifecycleToAggregationState
} from './lifecycle'
import { SessionState } from './state'

describe('canTransitionTask (DESIGN §3.5)', () => {
  it('allows the happy provisioning path', () => {
    expect(canTransitionTask(TaskLifecycle.None, TaskLifecycle.Provisioning)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.Provisioning, TaskLifecycle.Ready)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.Ready, TaskLifecycle.Deleting)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.Deleting, TaskLifecycle.Deleted)).toBe(true)
  })

  it('allows provision failure, retry and discard', () => {
    expect(canTransitionTask(TaskLifecycle.Provisioning, TaskLifecycle.ProvisionFailed)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.ProvisionFailed, TaskLifecycle.Provisioning)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.ProvisionFailed, TaskLifecycle.Deleted)).toBe(true)
  })

  it('allows delete failure with retry / force-forget (I4)', () => {
    expect(canTransitionTask(TaskLifecycle.Deleting, TaskLifecycle.DeleteFailed)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.DeleteFailed, TaskLifecycle.Deleting)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.DeleteFailed, TaskLifecycle.Deleted)).toBe(true)
  })

  it('allows Ready → Stale and stale recovery (I14)', () => {
    expect(canTransitionTask(TaskLifecycle.Ready, TaskLifecycle.Stale)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.Stale, TaskLifecycle.Provisioning)).toBe(true)
    expect(canTransitionTask(TaskLifecycle.Stale, TaskLifecycle.Deleting)).toBe(true)
  })

  it('forbids illegal jumps and any move out of the terminal Deleted state', () => {
    expect(canTransitionTask(TaskLifecycle.None, TaskLifecycle.Ready)).toBe(false)
    expect(canTransitionTask(TaskLifecycle.Ready, TaskLifecycle.Provisioning)).toBe(false)
    expect(canTransitionTask(TaskLifecycle.Deleted, TaskLifecycle.Ready)).toBe(false)
    expect(canTransitionTask(TaskLifecycle.Deleted, TaskLifecycle.Deleting)).toBe(false)
  })
})

describe('canTransitionSession (DESIGN §3.6)', () => {
  it('allows the happy start path', () => {
    expect(canTransitionSession(SessionLifecycle.None, SessionLifecycle.Created)).toBe(true)
    expect(canTransitionSession(SessionLifecycle.Created, SessionLifecycle.Starting)).toBe(true)
    expect(canTransitionSession(SessionLifecycle.Starting, SessionLifecycle.Running)).toBe(true)
    expect(canTransitionSession(SessionLifecycle.Running, SessionLifecycle.Stopping)).toBe(true)
    expect(canTransitionSession(SessionLifecycle.Stopping, SessionLifecycle.Closed)).toBe(true)
  })

  it('allows the failure branches', () => {
    expect(canTransitionSession(SessionLifecycle.Created, SessionLifecycle.CreateFailed)).toBe(true)
    expect(canTransitionSession(SessionLifecycle.Starting, SessionLifecycle.StartFailed)).toBe(true)
  })

  it('allows unexpected exit from Running or Stopping', () => {
    expect(canTransitionSession(SessionLifecycle.Running, SessionLifecycle.Exited)).toBe(true)
    expect(canTransitionSession(SessionLifecycle.Stopping, SessionLifecycle.Exited)).toBe(true)
  })

  it('forbids illegal jumps and moves out of terminal states', () => {
    expect(canTransitionSession(SessionLifecycle.Created, SessionLifecycle.Running)).toBe(false)
    expect(canTransitionSession(SessionLifecycle.Closed, SessionLifecycle.Running)).toBe(false)
    expect(canTransitionSession(SessionLifecycle.Exited, SessionLifecycle.Running)).toBe(false)
    expect(canTransitionSession(SessionLifecycle.StartFailed, SessionLifecycle.Starting)).toBe(
      false
    )
  })
})

describe('lifecycleToAggregationState (I12)', () => {
  it('maps Exited and StartFailed to Blocked regardless of state', () => {
    expect(lifecycleToAggregationState(SessionLifecycle.Exited, SessionState.Unknown)).toBe(
      SessionState.NeedsInput
    )
    expect(lifecycleToAggregationState(SessionLifecycle.StartFailed, SessionState.Working)).toBe(
      SessionState.NeedsInput
    )
  })

  it('passes through the evaluated state for a live session (Unknown in V1)', () => {
    expect(lifecycleToAggregationState(SessionLifecycle.Running, SessionState.Unknown)).toBe(
      SessionState.Unknown
    )
    // V2 forward-compat: a running session with a real state contributes it.
    expect(lifecycleToAggregationState(SessionLifecycle.Running, SessionState.Working)).toBe(
      SessionState.Working
    )
  })
})
