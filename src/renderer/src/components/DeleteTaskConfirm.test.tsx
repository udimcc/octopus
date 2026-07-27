import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DeleteTaskConfirm } from './DeleteTaskConfirm'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { CommandAck, TaskDTO } from '../../../shared/dto'

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

function seed(t: TaskDTO): void {
  useStore.getState().hydrate({
    tasks: [t],
    activeTaskId: t.id,
    sessionTypes: [],
    settings: { worktree: { location: '' }, terminal: {}, defaultSessionTypeId: 'terminal' },
    version: 1,
    thisWindowId: 'main',
    thisWindowRole: 'main',
    windows: []
  })
}

describe('<DeleteTaskConfirm>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  it('dispatches a plain delete on confirm', () => {
    installStubBridge()
    seed(task('t1', { name: 'Alpha' }))
    render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(window.octopusAPI.tasks.delete).toHaveBeenCalledWith({ taskId: 't1' })
  })

  it('escalates to the dirty step and re-dispatches with confirmedDirty on needsDirtyConfirm', async () => {
    // First call → needs dirty confirm; second (confirmed) → ok.
    const acks: CommandAck[] = [{ ok: false, needsDirtyConfirm: true }, { ok: true }]
    let call = 0
    installStubBridge({ ack: () => acks[call++] })
    seed(task('t1', { name: 'Alpha' }))
    render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    // The dialog escalates to "delete anyway".
    await waitFor(() => expect(screen.getByText('Uncommitted changes')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))

    await waitFor(() =>
      expect(window.octopusAPI.tasks.delete).toHaveBeenLastCalledWith({
        taskId: 't1',
        confirmedDirty: true
      })
    )
  })

  it('offers Force-forget for a stale task and dispatches force:true', () => {
    installStubBridge()
    seed(task('t1', { name: 'Alpha', lifecycle: 'stale' }))
    render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Force-forget' }))
    expect(window.octopusAPI.tasks.delete).toHaveBeenCalledWith({ taskId: 't1', force: true })
  })

  it('does NOT offer Force-forget for a ready task', () => {
    installStubBridge()
    seed(task('t1', { name: 'Alpha', lifecycle: 'ready' }))
    render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Force-forget' })).not.toBeInTheDocument()
  })

  it('surfaces an ack error inline', async () => {
    installStubBridge({ ack: () => ({ ok: false, error: 'worktree busy' }) })
    seed(task('t1', { name: 'Alpha' }))
    render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('worktree busy'))
  })

  it('cancel closes without dispatching', () => {
    installStubBridge()
    seed(task('t1', { name: 'Alpha' }))
    const onClose = vi.fn()
    render(<DeleteTaskConfirm taskId="t1" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(window.octopusAPI.tasks.delete).not.toHaveBeenCalled()
  })
})
