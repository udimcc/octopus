import { describe, it, expect } from 'vitest'
import { Session } from './session'
import { asTaskId, asSessionId, asTypeId } from './ids'
import { SessionLifecycle } from './lifecycle'
import { SessionState } from './state'
import { IllegalTransitionError } from './errors'

function newSession(): Session {
  return Session.create({
    id: asSessionId('s1'),
    taskId: asTaskId('t1'),
    typeId: asTypeId('terminal'),
    title: 'shell',
    config: { kind: 'terminal' },
    order: 0,
    createdAt: 5
  })
}

describe('Session (§3.6)', () => {
  it('starts in Created with Unknown state (V1)', () => {
    const s = newSession()
    expect(s.lifecycle).toBe(SessionLifecycle.Created)
    expect(s.state).toBe(SessionState.Unknown)
  })

  it('runs the happy start path', () => {
    const s = newSession()
    s.markStarting()
    s.markRunning()
    expect(s.lifecycle).toBe(SessionLifecycle.Running)
  })

  it('distinguishes user close (Closed) from process death (Exited)', () => {
    const closed = newSession()
    closed.markStarting()
    closed.markRunning()
    closed.markStopping()
    closed.markClosed()
    expect(closed.lifecycle).toBe(SessionLifecycle.Closed)

    const exited = newSession()
    exited.markStarting()
    exited.markRunning()
    exited.markExited(123)
    expect(exited.lifecycle).toBe(SessionLifecycle.Exited)
    expect(exited.toSnapshot().exitedAt).toBe(123)
  })

  it('rejects an illegal transition', () => {
    const s = newSession()
    expect(() => s.markRunning()).toThrow(IllegalTransitionError)
  })

  it('rename and setOrder mutate only those fields', () => {
    const s = newSession()
    s.rename('build')
    s.setOrder(3)
    expect(s.title).toBe('build')
    expect(s.order).toBe(3)
  })

  it('round-trips through a snapshot preserving lifecycle and state', () => {
    const s = newSession()
    s.markStarting()
    s.markRunning()
    const restored = Session.fromSnapshot(s.toSnapshot())
    expect(restored.lifecycle).toBe(SessionLifecycle.Running)
    expect(restored.state).toBe(SessionState.Unknown)
    expect(restored.title).toBe('shell')
  })
})
