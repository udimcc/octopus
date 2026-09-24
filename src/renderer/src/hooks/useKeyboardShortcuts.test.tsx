import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useKeyboardShortcuts, type KeyboardShortcutHandlers } from './useKeyboardShortcuts'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { SessionDTO, TaskDTO, WindowDTO } from '../../../shared/dto'

function Host(props: KeyboardShortcutHandlers): React.JSX.Element {
  useKeyboardShortcuts(props)
  return <div />
}

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

function task(id: string, over: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id,
    name: id,
    lifecycle: 'ready',
    state: 'unknown',
    sessions: [],
    position: 0,
    createdAt: 1000,
    ...over
  }
}

/** A worktree ref rooted at `repoRoot`, so a task groups under that repo (§5.1). */
function worktree(repoRoot: string): TaskDTO['worktree'] {
  return {
    path: `${repoRoot}/wt`,
    managed: true,
    provisionedBy: { script: 'p', args: [], repoRoot, provisionedAt: 1000 }
  }
}

function win(id: string, over: Partial<WindowDTO> = {}): WindowDTO {
  return {
    id,
    role: id === 'main' ? 'main' : 'secondary',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    createdAt: 1000,
    ...over
  }
}

function seed(
  tasks: TaskDTO[],
  activeTaskId?: string,
  thisWindowId = 'main',
  windows: WindowDTO[] = []
): void {
  useStore.getState().hydrate({
    tasks,
    activeTaskId,
    sessionTypes: [],
    settings: {
      worktree: { location: '' },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      groupTasksByRepo: true,
      sessionNextKey: 'Ctrl+Shift+ArrowRight',
      sessionPrevKey: 'Ctrl+Shift+ArrowLeft',
      taskNextKey: 'Ctrl+Shift+ArrowDown',
      taskPrevKey: 'Ctrl+Shift+ArrowUp',
      newSessionKey: 'Ctrl+Shift+KeyN',
      newTaskKey: 'Ctrl+Shift+KeyT',
      closeSessionKey: 'Ctrl+Shift+KeyW',
      searchKey: 'Ctrl+Shift+KeyF'
    },
    version: 1,
    thisWindowId,
    thisWindowRole: thisWindowId === 'main' ? 'main' : 'secondary',
    windows
  })
}

/** Fire a Ctrl+Shift chord by `code` (layout-independent). */
function chord(code: string, extra: Partial<KeyboardEventInit> = {}): void {
  fireEvent.keyDown(window, { code, ctrlKey: true, shiftKey: true, ...extra })
}

describe('useKeyboardShortcuts (§5.4 — Shift-gated)', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('IGNORES bare Ctrl chords so the terminal keeps Ctrl+C etc.', () => {
    seed([task('t1'), task('t2', { position: 1 })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    // Ctrl (no Shift) must not switch tasks — the safety rule.
    fireEvent.keyDown(window, { code: 'ArrowDown', ctrlKey: true, shiftKey: false })
    expect(useStore.getState().activeTaskId).toBe('t1')
    expect(window.octopusAPI.tasks.switch).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+ArrowDown cycles to the next task and switches (default binding)', () => {
    seed([task('t1'), task('t2', { position: 1 })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowDown')
    expect(useStore.getState().activeTaskId).toBe('t2')
    expect(window.octopusAPI.tasks.switch).toHaveBeenCalledWith({ taskId: 't2' })
  })

  it('Ctrl+Shift+ArrowUp cycles to the previous task, wrapping (default binding)', () => {
    seed([task('t1'), task('t2', { position: 1 })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowUp')
    expect(useStore.getState().activeTaskId).toBe('t2') // wrapped backwards
  })

  it('cycles tasks in the GROUPED visual order, not creation order', () => {
    // The scenario from the bug: repo A holds t1 then (later-created) t3; repo B holds
    // t2. Creation/`taskOrder` interleaves them ([t1, t2, t3]), but the grouped panel
    // shows A: t1, t3 then B: t2. Cycling from t1 must land on its repo-mate t3, not t2.
    const tasks = [
      task('t1', { worktree: worktree('/repo/a') }),
      task('t2', { position: 1, worktree: worktree('/repo/b') }),
      task('t3', { position: 2, worktree: worktree('/repo/a') })
    ]
    seed(tasks, 't1') // seed defaults groupTasksByRepo: true
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowDown')
    expect(useStore.getState().activeTaskId).toBe('t3')
    expect(window.octopusAPI.tasks.switch).toHaveBeenLastCalledWith({ taskId: 't3' })
    chord('ArrowDown') // t3 → t2 (crossing into repo B)
    expect(useStore.getState().activeTaskId).toBe('t2')
    chord('ArrowDown') // t2 → wraps to t1
    expect(useStore.getState().activeTaskId).toBe('t1')
  })

  it('cycles tasks in the FLAT (creation) order when grouping is off', () => {
    const tasks = [
      task('t1', { worktree: worktree('/repo/a') }),
      task('t2', { position: 1, worktree: worktree('/repo/b') }),
      task('t3', { position: 2, worktree: worktree('/repo/a') })
    ]
    seed(tasks, 't1')
    useStore.setState((s) => ({ settings: { ...s.settings, groupTasksByRepo: false } }))
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowDown') // flat: t1 → t2 (next in taskOrder, ignoring repo)
    expect(useStore.getState().activeTaskId).toBe('t2')
    chord('ArrowDown') // t2 → t3
    expect(useStore.getState().activeTaskId).toBe('t3')
  })

  it('Ctrl+Shift+Tab no longer cycles sessions (binding removed)', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 })],
      activeSessionId: 's1'
    })
    seed([t], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('Tab')
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
  })

  it('Ctrl+Shift+ArrowRight cycles to the next session (default binding)', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 })],
      activeSessionId: 's1'
    })
    seed([t], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowRight')
    // Switching now round-trips through the backend so it can cross window
    // boundaries (§5.4); the store re-points on the broadcast `activeSessionChanged`.
    expect(window.octopusAPI.sessions.switch).toHaveBeenCalledWith({ sessionId: 's2' })
  })

  it('Ctrl+Shift+ArrowLeft cycles to the previous session, wrapping', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 })],
      activeSessionId: 's1'
    })
    seed([t], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowLeft')
    expect(window.octopusAPI.sessions.switch).toHaveBeenCalledWith({ sessionId: 's2' }) // wrapped
  })

  it('honors independently configured next/prev chords (no opposite inference)', () => {
    // Three sessions with the MIDDLE one active so next/prev land on distinct
    // neighbors — switching now round-trips through the backend, so the local active
    // pointer doesn't advance between chords in this test (no broadcast).
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
      activeSessionId: 's2'
    })
    seed([t], 't1')
    // Two arbitrary, non-mirrored chords: next = Ctrl+Shift+↑, prev = Ctrl+Shift+→.
    useStore.setState((s) => ({
      settings: {
        ...s.settings,
        sessionNextKey: 'Ctrl+Shift+ArrowUp',
        sessionPrevKey: 'Ctrl+Shift+ArrowRight'
      }
    }))
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowUp')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's3' })
    chord('ArrowRight') // configured as PREV — not the opposite of ArrowUp
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's1' })
    // The default arrows are no longer bound once overridden.
    const callsBefore = vi.mocked(window.octopusAPI.sessions.switch).mock.calls.length
    chord('ArrowLeft')
    expect(vi.mocked(window.octopusAPI.sessions.switch).mock.calls.length).toBe(callsBefore)
  })

  it("cycles across windows GROUPED by window: main's tabs, then win-2's, then wraps (§5.4)", () => {
    // The user's scenario: window `main` hosts T1, T3; window `win-2` hosts T2. Global
    // tab order interleaves them ([s1, s2, s3]) but cycling groups by window rank, so the
    // walk is s1 → s3 (main's tabs) → s2 (win-2) → wrap → s1.
    const t = task('t1', {
      sessions: [
        session('s1', { windowId: 'main' }),
        session('s2', { order: 1, windowId: 'win-2' }),
        session('s3', { order: 2, windowId: 'main' })
      ],
      activeSessionId: 's1'
    })
    seed([t], 't1', 'main', [win('main'), win('win-2')])
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowRight')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's3' })
    // The store re-points on the broadcast `activeSessionChanged`; the stub bridge does
    // not round-trip, so advance the global pointer manually to simulate it.
    useStore.setState((s) => ({ activeSessionByTask: { ...s.activeSessionByTask, t1: 's3' } }))
    chord('ArrowRight')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's2' })
    useStore.setState((s) => ({ activeSessionByTask: { ...s.activeSessionByTask, t1: 's2' } }))
    chord('ArrowRight')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's1' }) // wrapped
  })

  it("wraps only after the last window's tabs, not within a single window", () => {
    const t = task('t1', {
      sessions: [
        session('s1', { windowId: 'main' }),
        session('s2', { order: 1, windowId: 'win-2' }),
        session('s3', { order: 2, windowId: 'main' })
      ],
      activeSessionId: 's3' // last of main's tabs; next crosses into win-2, not wrap
    })
    seed([t], 't1', 'main', [win('main'), win('win-2')])
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowRight')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's2' })
  })

  it('anchors on the GLOBAL active session, wherever it is hosted', () => {
    // Global activeSessionByTask points at s2 (in win-2), while this renderer is `main`.
    // Grouped order is [s1, s3, s2]; from s2 (last), ArrowRight wraps to s1.
    const t = task('t1', {
      sessions: [
        session('s1', { windowId: 'main' }),
        session('s2', { order: 1, windowId: 'win-2' }),
        session('s3', { order: 2, windowId: 'main' })
      ],
      activeSessionId: 's2'
    })
    seed([t], 't1', 'main', [win('main'), win('win-2')])
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowRight')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's1' })
  })

  it('cycles from a secondary window across into the main window', () => {
    // Same layout, but the focused renderer IS win-2 (hosting only s2). Cycling still
    // spans all windows off the shared global pointer; from s2, ArrowRight wraps to s1.
    const t = task('t1', {
      sessions: [
        session('s1', { windowId: 'main' }),
        session('s2', { order: 1, windowId: 'win-2' }),
        session('s3', { order: 2, windowId: 'main' })
      ],
      activeSessionId: 's2'
    })
    seed([t], 't1', 'win-2', [win('main'), win('win-2')])
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowRight')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's1' })
  })

  it('matches a free-form (non-Ctrl+Shift) chord before the fixed gate', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
      activeSessionId: 's2'
    })
    seed([t], 't1')
    // Alt+K would be dropped by the Ctrl+Shift gate; matching runs before it.
    useStore.setState((s) => ({
      settings: { ...s.settings, sessionNextKey: 'Alt+KeyK', sessionPrevKey: 'Alt+KeyJ' }
    }))
    render(<Host onNewTask={vi.fn()} />)
    fireEvent.keyDown(window, { code: 'KeyK', altKey: true })
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's3' })
    fireEvent.keyDown(window, { code: 'KeyJ', altKey: true })
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's1' })
  })

  it('Ctrl+Shift+N opens a new terminal in the active (ready) task (default binding)', () => {
    seed([task('t1', { lifecycle: 'ready' })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('KeyN')
    expect(window.octopusAPI.sessions.create).toHaveBeenCalledWith({ taskId: 't1' })
  })

  it('Ctrl+Shift+N does nothing when the active task is not ready', () => {
    seed([task('t1', { lifecycle: 'provisioning' })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('KeyN')
    expect(window.octopusAPI.sessions.create).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+T calls onNewTask (default binding)', () => {
    const onNewTask = vi.fn()
    render(<Host onNewTask={onNewTask} />)
    chord('KeyT')
    expect(onNewTask).toHaveBeenCalled()
  })

  it('Ctrl+Shift+W closes the active session (default binding)', () => {
    const t = task('t1', { sessions: [session('s1')], activeSessionId: 's1' })
    seed([t], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('KeyW')
    expect(window.octopusAPI.sessions.close).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('Ctrl+Shift+F calls onSearch (default binding)', () => {
    const onSearch = vi.fn()
    seed([task('t1')], 't1')
    render(<Host onNewTask={vi.fn()} onSearch={onSearch} />)
    chord('KeyF')
    expect(onSearch).toHaveBeenCalled()
  })
})
