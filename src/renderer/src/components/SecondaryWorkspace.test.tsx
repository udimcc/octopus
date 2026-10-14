import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SecondaryWorkspace } from './SecondaryWorkspace'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { SessionDTO, TaskDTO, WindowedWorkspaceStateDTO } from '../../../shared/dto'

/**
 * Stub the session-view resolver so a pane renders a cheap marker instead of the
 * real xterm-backed `TerminalPane` (which needs a WebGL/canvas context jsdom
 * lacks). This test is about WHICH sessions the secondary window renders — the
 * per-window `windowId` filter — not the terminal internals.
 */
vi.mock('../session-views/session-view-factory', () => ({
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
    state: 'unknown',
    order: 0,
    createdAt: 1000,
    windowId: 'main',
    ...over
  }
}

/** Hydrate one active task whose sessions are split across the main + a secondary window. */
function seed(sessions: SessionDTO[], thisWindowId: string): void {
  const t: TaskDTO = {
    id: 't1',
    name: 'Alpha',
    lifecycle: 'ready',
    state: 'unknown',
    sessions,
    activeSessionId: sessions[0]?.id,
    position: 0,
    createdAt: 1000,
    groups: []
  }
  const state: WindowedWorkspaceStateDTO = {
    tasks: [t],
    activeTaskId: 't1',
    sessionTypes: [
      {
        typeId: 'terminal',
        displayName: 'Terminal',
        icon: '',
        availableFromVersion: 1,
        configSchema: {}
      }
    ],
    issues: [],
    settings: {
      worktree: { location: '' },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      groupTasksByRepo: true
    },
    version: 1,
    thisWindowId,
    thisWindowRole: 'secondary',
    windows: []
  }
  useStore.getState().hydrate(state)
}

describe('<SecondaryWorkspace>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('renders only the active task’s sessions assigned to THIS window', () => {
    seed(
      [
        session('s1', { windowId: 'main' }),
        session('s2', { windowId: 'win-2', order: 1 }),
        session('s3', { windowId: 'win-2', order: 2 })
      ],
      'win-2'
    )
    render(<SecondaryWorkspace />)

    // s2 + s3 live in win-2 → their panes mount here; s1 (main window) does not.
    expect(screen.getByTestId('pane-s2')).toBeInTheDocument()
    expect(screen.getByTestId('pane-s3')).toBeInTheDocument()
    expect(screen.queryByTestId('pane-s1')).not.toBeInTheDocument()
  })

  it('shows the empty-state prompt when this window hosts none of the active task’s sessions', () => {
    seed([session('s1', { windowId: 'main' })], 'win-2')
    render(<SecondaryWorkspace />)

    expect(screen.getByText(/drag a tab onto this window/i)).toBeInTheDocument()
    expect(screen.queryByTestId('pane-s1')).not.toBeInTheDocument()
  })

  it('hides the empty-state prompt once this window hosts a session', () => {
    seed([session('s1', { windowId: 'win-2' })], 'win-2')
    render(<SecondaryWorkspace />)

    expect(screen.queryByText(/drag a tab onto this window/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('pane-s1')).toBeInTheDocument()
  })
})
