import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionTabBar } from './SessionTabBar'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { SessionDTO, SessionTypeDTO, TaskDTO } from '../../../shared/dto'

function session(id: string, over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id,
    taskId: 't1',
    typeId: 'terminal',
    title: id,
    config: { kind: 'terminal' },
    lifecycle: 'running',
    state: 'unknown',
    order: 0,
    createdAt: 1000,
    windowId: 'main',
    ...over
  }
}

const TERMINAL_TYPE: SessionTypeDTO = {
  typeId: 'terminal',
  displayName: 'Terminal',
  icon: '',
  availableFromVersion: 1,
  configSchema: {}
}

function seed(opts: {
  lifecycle?: string
  sessions?: SessionDTO[]
  sessionTypes?: SessionTypeDTO[]
}): void {
  const sessions = opts.sessions ?? []
  const t: TaskDTO = {
    id: 't1',
    name: 'Alpha',
    lifecycle: opts.lifecycle ?? 'ready',
    state: 'unknown',
    sessions,
    activeSessionId: sessions[0]?.id,
    position: 0,
    createdAt: 1000
  }
  useStore.getState().hydrate({
    tasks: [t],
    activeTaskId: 't1',
    sessionTypes: opts.sessionTypes ?? [TERMINAL_TYPE],
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
  })
}

describe('<SessionTabBar>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('renders a tab per session, with an (exited) suffix on dead ones', () => {
    seed({
      sessions: [
        session('s1', { title: 'sh' }),
        session('s2', { title: 'build', lifecycle: 'exited', order: 1 })
      ]
    })
    render(<SessionTabBar taskId="t1" />)
    expect(screen.getByRole('tab', { name: 'sh' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'build' })).toBeInTheDocument()
    expect(screen.getByText('(exited)')).toBeInTheDocument()
  })

  it('activates a session on click: local pointer + backend round-trip', () => {
    seed({ sessions: [session('s1'), session('s2', { order: 1 })] })
    render(<SessionTabBar taskId="t1" />)
    fireEvent.click(screen.getByRole('tab', { name: 's2' }))
    // Local pointer moves for instant feedback…
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    // …AND the switch round-trips so the pointer persists (I10) and every window is
    // told via `activeSessionChanged` — the cross-window ready-for-review clear (§9.5).
    expect(window.octopusAPI.sessions.switch).toHaveBeenCalledWith({ sessionId: 's2' })
  })

  it('closes a session via its × button', () => {
    seed({ sessions: [session('s1')] })
    render(<SessionTabBar taskId="t1" />)
    fireEvent.click(screen.getByRole('button', { name: 'close session' }))
    expect(window.octopusAPI.sessions.close).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('creates a terminal session immediately (single type) when ready', () => {
    seed({ lifecycle: 'ready', sessions: [] })
    render(<SessionTabBar taskId="t1" />)
    fireEvent.click(screen.getByRole('button', { name: 'new session' }))
    expect(window.octopusAPI.sessions.create).toHaveBeenCalledWith({
      taskId: 't1',
      typeId: 'terminal'
    })
  })

  it('disables new-session while the task is not ready', () => {
    seed({ lifecycle: 'provisioning', sessions: [] })
    render(<SessionTabBar taskId="t1" />)
    expect(screen.getByRole('button', { name: 'new session' })).toBeDisabled()
  })

  it('a working session with a stale review flag shows the Working icon, not review (§9.5)', () => {
    // The gating flows through `sessionDisplayState`: even though s1 still carries a
    // ready-for-review flag (raised earlier on working→waiting), its CURRENT state is
    // working, so the tab must show the pulsing Working icon — the bug this fixes.
    seed({ sessions: [session('s1', { title: 'sh', state: 'working' })] })
    useStore.setState({ readyForReview: { s1: true } })
    render(<SessionTabBar taskId="t1" />)
    const tab = screen.getByRole('tab', { name: 'sh' })
    expect(tab.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Working')
  })

  it('an idle session with a review flag shows the Ready-for-review icon (§9.5)', () => {
    seed({ sessions: [session('s1', { title: 'sh', state: 'waiting' })] })
    useStore.setState({ readyForReview: { s1: true } })
    render(<SessionTabBar taskId="t1" />)
    const tab = screen.getByRole('tab', { name: 'sh' })
    expect(tab.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ready for review')
  })

  it('offers a dropdown menu when more than one session type is available', () => {
    seed({
      lifecycle: 'ready',
      sessions: [],
      sessionTypes: [TERMINAL_TYPE, { ...TERMINAL_TYPE, typeId: 'jenkins', displayName: 'Jenkins' }]
    })
    render(<SessionTabBar taskId="t1" />)
    // With >1 type, the button opens a menu rather than creating immediately.
    fireEvent.click(screen.getByRole('button', { name: 'new session' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Jenkins' }))
    expect(window.octopusAPI.sessions.create).toHaveBeenCalledWith({
      taskId: 't1',
      typeId: 'jenkins'
    })
  })
})
