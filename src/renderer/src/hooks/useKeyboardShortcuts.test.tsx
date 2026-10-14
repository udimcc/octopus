import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useKeyboardShortcuts, type KeyboardShortcutHandlers } from './useKeyboardShortcuts'
import { DeleteTaskConfirm } from '../components/DeleteTaskConfirm'
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
    issues: [],
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
      searchKey: 'Ctrl+Shift+KeyF',
      issuesKey: 'Alt+Shift+KeyI'
    },
    version: 1,
    thisWindowId,
    thisWindowRole: thisWindowId === 'main' ? 'main' : 'secondary',
    windows
  })
}

/**
 * Fire a Ctrl+Shift chord by `code` (layout-independent). Returns the same boolean
 * `dispatchEvent`/`fireEvent` does: `false` iff `preventDefault()` was called, so
 * callers can assert a chord was CONSUMED even when it's a suppressed no-op.
 */
function chord(code: string, extra: Partial<KeyboardEventInit> = {}): boolean {
  return fireEvent.keyDown(window, { code, ctrlKey: true, shiftKey: true, ...extra })
}

/** Fire the default Alt+Shift+I "toggle Issues drawer" chord. */
function issuesChord(): boolean {
  return fireEvent.keyDown(window, { code: 'KeyI', altKey: true, shiftKey: true })
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
    // The host (this window) moves its mark on the broadcast `activeSessionChanged`; the
    // stub bridge does not round-trip, so apply the event manually to simulate it.
    const switched = (sessionId: string, windowId: string): void =>
      useStore
        .getState()
        .applyEvent({ type: 'activeSessionChanged', taskId: 't1', sessionId, windowId })
    switched('s3', 'main')
    chord('ArrowRight')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's2' })
    // s2 lives in win-2: that window becomes the focused one and handles the next press
    // (covered below); THIS window keeps its own mark, so it still anchors on s3 (§3.7).
    switched('s2', 'win-2')
    expect(useStore.getState().activeSessionByTask.t1).toBe('s3')
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

  it("anchors on THIS window's mark, not a session focused in another window (§3.7)", () => {
    // The persisted last-focused session is s2 (in win-2), while this renderer is `main`,
    // whose mark is its own s3. Grouped order is [s1, s3, s2]; from s3, ArrowRight goes
    // to s2 — the walk continues from what THIS (focused) window shows.
    const t = task('t1', {
      sessions: [
        session('s1', { windowId: 'main' }),
        session('s2', { order: 1, windowId: 'win-2' }),
        session('s3', { order: 2, windowId: 'main' })
      ],
      activeSessionId: 's2'
    })
    seed([t], 't1', 'main', [win('main'), win('win-2')])
    useStore.setState((s) => ({ activeSessionByTask: { ...s.activeSessionByTask, t1: 's3' } }))
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowRight')
    expect(window.octopusAPI.sessions.switch).toHaveBeenLastCalledWith({ sessionId: 's2' })
  })

  it("Ctrl+Shift+W closes THIS window's mark, not a session focused elsewhere (§3.7)", () => {
    const t = task('t1', {
      sessions: [
        session('s1', { windowId: 'main' }),
        session('s2', { order: 1, windowId: 'win-2' })
      ],
      activeSessionId: 's2'
    })
    seed([t], 't1', 'main', [win('main'), win('win-2')])
    render(<Host onNewTask={vi.fn()} />)
    chord('KeyW')
    expect(window.octopusAPI.sessions.close).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('cycles from a secondary window across into the main window', () => {
    // Same layout, but the focused renderer IS win-2 (hosting only s2, its mark). Cycling
    // still spans all windows; from s2 (last in grouped order), ArrowRight wraps to s1.
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

  it('Alt+Shift+I toggles the Issues drawer locally in the main window (default binding)', () => {
    seed([task('t1')], 't1', 'main')
    render(<Host onNewTask={vi.fn()} />)
    expect(useStore.getState().issuesDrawerOpen).toBe(false)
    issuesChord()
    expect(useStore.getState().issuesDrawerOpen).toBe(true)
    expect(window.octopusAPI.issues.toggleDrawer).not.toHaveBeenCalled()
    // And it closes again on a second press.
    issuesChord()
    expect(useStore.getState().issuesDrawerOpen).toBe(false)
  })

  it('Alt+Shift+I relays to main over IPC from a secondary window, with no local drawer', () => {
    seed([task('t1')], 't1', 'win-2', [win('main'), win('win-2')])
    render(<Host onNewTask={vi.fn()} />)
    issuesChord()
    expect(window.octopusAPI.issues.toggleDrawer).toHaveBeenCalledTimes(1)
    // A secondary window has no drawer of its own to toggle.
    expect(useStore.getState().issuesDrawerOpen).toBe(false)
  })

  it('honors a non-default issuesKey binding, both to open and close the drawer', () => {
    seed([task('t1')], 't1', 'main')
    useStore.setState((s) => ({ settings: { ...s.settings, issuesKey: 'Alt+KeyQ' } }))
    render(<Host onNewTask={vi.fn()} />)
    expect(useStore.getState().issuesDrawerOpen).toBe(false)
    fireEvent.keyDown(window, { code: 'KeyQ', altKey: true })
    expect(useStore.getState().issuesDrawerOpen).toBe(true)
    // The default Alt+Shift+I is no longer bound once overridden.
    issuesChord()
    expect(useStore.getState().issuesDrawerOpen).toBe(true)
    fireEvent.keyDown(window, { code: 'KeyQ', altKey: true })
    expect(useStore.getState().issuesDrawerOpen).toBe(false)
  })

  describe('Escape fallback (drawer open, focus outside its DOM subtree)', () => {
    it('is a no-op (and does not call preventDefault) when the drawer is CLOSED in the main window', () => {
      seed([task('t1')], 't1', 'main')
      render(<Host onNewTask={vi.fn()} />)
      expect(useStore.getState().issuesDrawerOpen).toBe(false)
      expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(true)
      expect(useStore.getState().issuesDrawerOpen).toBe(false)
    })

    it("closes the main window's open drawer", () => {
      seed([task('t1')], 't1', 'main')
      useStore.setState({ issuesDrawerOpen: true })
      render(<Host onNewTask={vi.fn()} />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(useStore.getState().issuesDrawerOpen).toBe(false)
    })

    it('is a no-op while any [aria-modal="true"] element exists in the DOM', () => {
      seed([task('t1')], 't1', 'main')
      useStore.setState({ issuesDrawerOpen: true })
      render(<Host onNewTask={vi.fn()} />)
      const modal = document.createElement('div')
      modal.setAttribute('aria-modal', 'true')
      document.body.appendChild(modal)
      try {
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(useStore.getState().issuesDrawerOpen).toBe(true)
      } finally {
        modal.remove()
      }
    })

    it('is a no-op in a secondary window even with issuesDrawerOpen set', () => {
      seed([task('t1')], 't1', 'win-2', [win('main'), win('win-2')])
      useStore.setState({ issuesDrawerOpen: true })
      render(<Host onNewTask={vi.fn()} />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(useStore.getState().issuesDrawerOpen).toBe(true)
    })

    // Not just a state check: a real App-level modal (`DeleteTaskConfirm`, same
    // `stopPropagation` as `NewTaskModal`/`SettingsModal`) sits over the drawer and
    // must swallow Escape itself before it ever reaches this hook's `window`
    // listener — a state-only assertion would still pass if that modal's own
    // `e.stopPropagation()` (DeleteTaskConfirm.tsx:~251) were deleted, since the
    // `[aria-modal="true"]` DOM check here would still bail independently.
    it('never reaches the window listener when an App-level modal is open over the drawer', () => {
      const t = task('t1')
      seed([t], 't1', 'main')
      useStore.setState({ issuesDrawerOpen: true })
      render(
        <>
          <Host onNewTask={vi.fn()} />
          <DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />
        </>
      )
      const spy = vi.fn()
      window.addEventListener('keydown', spy)
      try {
        fireEvent.keyDown(screen.getByRole('dialog', { name: 'Delete Task' }), { key: 'Escape' })
        expect(spy).not.toHaveBeenCalled()
        expect(useStore.getState().issuesDrawerOpen).toBe(true)
      } finally {
        window.removeEventListener('keydown', spy)
      }
    })
  })

  describe('drawer-open chord suppression', () => {
    it('suppresses newSession/newTask/closeSession/search (but still consumes the chord); navigation chords still act', () => {
      const t1 = task('t1', {
        lifecycle: 'ready',
        sessions: [session('s1')],
        activeSessionId: 's1'
      })
      const t2 = task('t2', { position: 1 })
      seed([t1, t2], 't1', 'main')
      useStore.setState({ issuesDrawerOpen: true })
      const onNewTask = vi.fn()
      const onSearch = vi.fn()
      render(<Host onNewTask={onNewTask} onSearch={onSearch} />)

      expect(chord('KeyN')).toBe(false) // preventDefault still ran
      expect(window.octopusAPI.sessions.create).not.toHaveBeenCalled()

      expect(chord('KeyT')).toBe(false)
      expect(onNewTask).not.toHaveBeenCalled()

      expect(chord('KeyW')).toBe(false)
      expect(window.octopusAPI.sessions.close).not.toHaveBeenCalled()

      expect(chord('KeyF')).toBe(false)
      expect(onSearch).not.toHaveBeenCalled()

      // Session/task navigation chords are exempt and still act while the drawer
      // covers the workspace.
      expect(chord('ArrowDown')).toBe(false)
      expect(useStore.getState().activeTaskId).toBe('t2')
      expect(window.octopusAPI.tasks.switch).toHaveBeenCalledWith({ taskId: 't2' })
      // issuesKey itself is also exempt (it IS the drawer toggle).
      expect(issuesChord()).toBe(false)
      expect(useStore.getState().issuesDrawerOpen).toBe(false)
    })
  })
})
