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
    settings: { worktree: { location: '' }, terminal: {}, defaultSessionTypeId: 'terminal' },
    version: 1
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
