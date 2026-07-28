import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useKeyboardShortcuts, type KeyboardShortcutHandlers } from './useKeyboardShortcuts'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { SessionDTO, TaskDTO } from '../../../shared/dto'

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

function seed(tasks: TaskDTO[], activeTaskId?: string): void {
  useStore.getState().hydrate({
    tasks,
    activeTaskId,
    sessionTypes: [],
    settings: {
      worktree: { location: '' },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      sessionNextKey: 'Ctrl+Shift+ArrowRight',
      sessionPrevKey: 'Ctrl+Shift+ArrowLeft'
    },
    version: 1,
    thisWindowId: 'main',
    thisWindowRole: 'main',
    windows: []
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
    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true, shiftKey: false })
    expect(useStore.getState().activeTaskId).toBe('t1')
    expect(window.octopusAPI.tasks.switch).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+] cycles to the next task and switches', () => {
    seed([task('t1'), task('t2', { position: 1 })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('BracketRight')
    expect(useStore.getState().activeTaskId).toBe('t2')
    expect(window.octopusAPI.tasks.switch).toHaveBeenCalledWith({ taskId: 't2' })
  })

  it('Ctrl+Shift+[ cycles to the previous task, wrapping', () => {
    seed([task('t1'), task('t2', { position: 1 })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('BracketLeft')
    expect(useStore.getState().activeTaskId).toBe('t2') // wrapped backwards
  })

  it('Ctrl+Shift+Tab cycles the active session within the active task', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 })],
      activeSessionId: 's1'
    })
    seed([t], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('Tab')
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
  })

  it('Ctrl+Shift+ArrowRight cycles to the next session (default binding)', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 })],
      activeSessionId: 's1'
    })
    seed([t], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowRight')
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
  })

  it('Ctrl+Shift+ArrowLeft cycles to the previous session, wrapping', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 })],
      activeSessionId: 's1'
    })
    seed([t], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('ArrowLeft')
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2') // wrapped backwards
  })

  it('honors independently configured next/prev chords (no opposite inference)', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 })],
      activeSessionId: 's1'
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
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    chord('ArrowRight') // configured as PREV — not the opposite of ArrowUp
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
    // The default arrows are no longer bound once overridden.
    chord('ArrowLeft')
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
  })

  it('matches a free-form (non-Ctrl+Shift) chord before the fixed gate', () => {
    const t = task('t1', {
      sessions: [session('s1'), session('s2', { order: 1 })],
      activeSessionId: 's1'
    })
    seed([t], 't1')
    // Alt+K would be dropped by the Ctrl+Shift gate; matching runs before it.
    useStore.setState((s) => ({
      settings: { ...s.settings, sessionNextKey: 'Alt+KeyK', sessionPrevKey: 'Alt+KeyJ' }
    }))
    render(<Host onNewTask={vi.fn()} />)
    fireEvent.keyDown(window, { code: 'KeyK', altKey: true })
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    fireEvent.keyDown(window, { code: 'KeyJ', altKey: true })
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
  })

  it('Ctrl+Shift+T opens a new terminal in the active (ready) task', () => {
    seed([task('t1', { lifecycle: 'ready' })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('KeyT')
    expect(window.octopusAPI.sessions.create).toHaveBeenCalledWith({ taskId: 't1' })
  })

  it('Ctrl+Shift+T does nothing when the active task is not ready', () => {
    seed([task('t1', { lifecycle: 'provisioning' })], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('KeyT')
    expect(window.octopusAPI.sessions.create).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+N calls onNewTask', () => {
    const onNewTask = vi.fn()
    render(<Host onNewTask={onNewTask} />)
    chord('KeyN')
    expect(onNewTask).toHaveBeenCalled()
  })

  it('Ctrl+Shift+W closes the active session', () => {
    const t = task('t1', { sessions: [session('s1')], activeSessionId: 's1' })
    seed([t], 't1')
    render(<Host onNewTask={vi.fn()} />)
    chord('KeyW')
    expect(window.octopusAPI.sessions.close).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('Ctrl+Shift+F calls onSearch', () => {
    const onSearch = vi.fn()
    seed([task('t1')], 't1')
    render(<Host onNewTask={vi.fn()} onSearch={onSearch} />)
    chord('KeyF')
    expect(onSearch).toHaveBeenCalled()
  })
})
