import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { App } from './App'
import { useStore, initialData, FOCUS_FLASH_MS } from './store/store'
import { installStubBridge } from './test-support/stub-bridge'
import type { SessionDTO, WindowedWorkspaceStateDTO } from '../../shared/dto'

/**
 * The App-level focus wiring: persisting THIS window's focused session (§5.4, I10),
 * expiring the focus flash, and the "looked at" relay on a focus gain (§9.5). The
 * session panes are stubbed (xterm needs a canvas jsdom lacks) — only the wiring matters.
 */
vi.mock('./session-views/session-view-factory', () => ({
  resolveSessionView: () => (props: { sessionId: string }) => (
    <div data-testid={`pane-${props.sessionId}`} />
  )
}))

function session(id: string, over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id,
    taskId: 't1',
    typeId: 'terminal',
    title: id,
    config: { kind: 'terminal' },
    lifecycle: 'running',
    state: 'waiting',
    order: 0,
    createdAt: 1000,
    windowId: 'main',
    ...over
  }
}

/** t1: s1, s2 in `main`, s3 in `win-2`; the persisted pointer is s2. */
const STATE: WindowedWorkspaceStateDTO = {
  tasks: [
    {
      id: 't1',
      name: 'Alpha',
      lifecycle: 'ready',
      state: 'waiting',
      sessions: [
        session('s1'),
        session('s2', { order: 1 }),
        session('s3', { order: 2, windowId: 'win-2' })
      ],
      activeSessionId: 's2',
      position: 0,
      createdAt: 1000,
      groups: []
    }
  ],
  activeTaskId: 't1',
  sessionTypes: [],
  issues: [],
  settings: {
    worktree: { location: '' },
    terminal: {},
    defaultSessionTypeId: 'terminal',
    groupTasksByRepo: true
  },
  version: 1,
  thisWindowId: 'main',
  thisWindowRole: 'main',
  windows: []
}

const blur = (): void => {
  act(() => {
    window.dispatchEvent(new Event('blur'))
  })
}
const focus = (): void => {
  act(() => {
    window.dispatchEvent(new Event('focus'))
  })
}

/** Render the App and wait until the mount-time hydrate has landed. */
async function boot(hasFocus: boolean): Promise<void> {
  vi.spyOn(document, 'hasFocus').mockReturnValue(hasFocus)
  render(<App />)
  await waitFor(() => expect(useStore.getState().activeSessionByTask.t1).toBe('s2'))
}

describe('<App> window focus wiring', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge({ state: STATE })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('persists THIS window’s mark as the focused session while focused (I10)', async () => {
    await boot(true)
    expect(window.octopusAPI.sessions.focus).toHaveBeenCalledWith({ sessionId: 's2' })
    act(() => useStore.getState().setActiveSession('t1', 's1'))
    expect(window.octopusAPI.sessions.focus).toHaveBeenLastCalledWith({ sessionId: 's1' })
    expect(window.octopusAPI.sessions.focus).toHaveBeenCalledTimes(2)
  })

  it('does not re-send an unchanged focused session', async () => {
    await boot(true)
    act(() => useStore.getState().setActiveSession('t1', 's2'))
    act(() => useStore.setState({ hasUnseenFinishedTurn: { s1: true } }))
    expect(window.octopusAPI.sessions.focus).toHaveBeenCalledTimes(1)
  })

  it('a blurred window persists nothing; gaining focus (click / Alt+Tab) persists its mark', async () => {
    await boot(false)
    expect(window.octopusAPI.sessions.focus).not.toHaveBeenCalled()
    focus()
    expect(window.octopusAPI.sessions.focus).toHaveBeenCalledWith({ sessionId: 's2' })
  })

  it('re-sends the same mark after a blur + refocus (another window may have moved it)', async () => {
    await boot(true)
    blur()
    focus()
    expect(window.octopusAPI.sessions.focus).toHaveBeenCalledTimes(2)
    expect(window.octopusAPI.sessions.focus).toHaveBeenLastCalledWith({ sessionId: 's2' })
  })

  it('refocusing flashes the marked tab, which ends after FOCUS_FLASH_MS (§5.4)', async () => {
    await boot(true)
    vi.useFakeTimers()
    blur()
    focus()
    const tab = screen.getByRole('tab', { name: 's2' })
    expect(tab).toHaveClass('session-tab--focus-flash')
    expect(screen.getByRole('tab', { name: 's1' })).not.toHaveClass('session-tab--focus-flash')
    act(() => vi.advanceTimersByTime(FOCUS_FLASH_MS - 1))
    expect(tab).toHaveClass('session-tab--focus-flash')
    act(() => vi.advanceTimersByTime(1))
    expect(tab).not.toHaveClass('session-tab--focus-flash')
  })

  it('the first appearance of a window does not flash', async () => {
    await boot(false)
    focus()
    expect(screen.getByRole('tab', { name: 's2' })).not.toHaveClass('session-tab--focus-flash')
  })

  it('a turn finished while blurred is marked seen — and relayed — on refocus (§9.5)', async () => {
    await boot(true)
    blur()
    act(() => useStore.setState({ hasUnseenFinishedTurn: { s2: true } }))
    expect(window.octopusAPI.sessions.markSeen).not.toHaveBeenCalled()
    focus()
    expect(useStore.getState().hasUnseenFinishedTurn.s2).toBeUndefined()
    expect(window.octopusAPI.sessions.markSeen).toHaveBeenCalledWith({ sessionId: 's2' })
  })
})
