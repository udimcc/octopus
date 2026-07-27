import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProgressPanel } from './ProgressPanel'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { TaskDTO } from '../../../shared/dto'

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

/** Seed the store as if hydrated with the given tasks + active id. */
function seed(tasks: TaskDTO[], activeTaskId?: string): void {
  useStore.getState().hydrate({
    tasks,
    activeTaskId,
    sessionTypes: [],
    settings: { worktree: { location: '' }, terminal: {}, defaultSessionTypeId: 'terminal' },
    version: 1,
    thisWindowId: 'main',
    thisWindowRole: 'main',
    windows: []
  })
}

describe('<ProgressPanel>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('lists tasks in order with a lifecycle suffix for non-ready tasks', () => {
    seed([
      task('t1', { name: 'Alpha', position: 0 }),
      task('t2', { name: 'Beta', position: 1, lifecycle: 'provisioning' })
    ])
    render(<ProgressPanel onNewTask={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    // The non-ready task shows its lifecycle.
    expect(screen.getByText('(provisioning)')).toBeInTheDocument()
  })

  it('disables Delete Task when there is no active task, enables it otherwise', () => {
    seed([task('t1', { name: 'Alpha' })]) // no activeTaskId
    const { rerender } = render(<ProgressPanel onNewTask={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Delete Task' })).toBeDisabled()

    seed([task('t1', { name: 'Alpha' })], 't1')
    rerender(<ProgressPanel onNewTask={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Delete Task' })).toBeEnabled()
  })

  it('calls onNewTask from the + New Task button', () => {
    const onNewTask = vi.fn()
    render(<ProgressPanel onNewTask={onNewTask} />)
    fireEvent.click(screen.getByRole('button', { name: '+ New Task' }))
    expect(onNewTask).toHaveBeenCalled()
  })

  it('switching a task sets it active locally and dispatches tasks.switch', () => {
    seed([task('t1', { name: 'Alpha' }), task('t2', { name: 'Beta', position: 1 })], 't1')
    render(<ProgressPanel onNewTask={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    expect(window.octopusAPI.tasks.switch).toHaveBeenCalledWith({ taskId: 't2' })
    expect(useStore.getState().activeTaskId).toBe('t2')
  })

  it('opens the Delete confirm for the active task', () => {
    seed([task('t1', { name: 'Alpha' })], 't1')
    render(<ProgressPanel onNewTask={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Task' }))
    expect(screen.getByRole('dialog', { name: 'Delete Task' })).toBeInTheDocument()
    expect(screen.getByText(/Delete "Alpha"\?/)).toBeInTheDocument()
  })

  it('does not re-open the Delete confirm for another task after the target is deleted', () => {
    seed([task('t1', { name: 'Alpha' }), task('t2', { name: 'Beta', position: 1 })], 't1')
    render(<ProgressPanel onNewTask={vi.fn()} />)

    // Open the delete confirm for the active task (t1).
    fireEvent.click(screen.getByRole('button', { name: 'Delete Task' }))
    expect(screen.getByRole('dialog', { name: 'Delete Task' })).toBeInTheDocument()

    // The delete completes: the store drops t1 and clears activeTaskId.
    useStore.getState().applyEvent({ type: 'taskDeleted', taskId: 't1' })

    // Switching to another task must NOT revive the delete dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    expect(screen.queryByRole('dialog', { name: 'Delete Task' })).not.toBeInTheDocument()
  })

  it('opens the Settings modal from the gear', () => {
    render(<ProgressPanel onNewTask={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })
})
