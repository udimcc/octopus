import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { DeleteTaskConfirm } from './DeleteTaskConfirm'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { CommandAck, IssueDTO, TaskDTO, WorktreeRefDTO } from '../../../shared/dto'

function worktree(managed: boolean): WorktreeRefDTO {
  return {
    path: '/wt',
    managed,
    provisionedBy: { script: 's', args: [], repoRoot: '/repo', provisionedAt: 1 }
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

function issue(id: string, over: Partial<IssueDTO> = {}): IssueDTO {
  return {
    id,
    name: id,
    description: '',
    status: 'todo',
    createdAt: 1000,
    updatedAt: 1000,
    ...over
  }
}

function seed(t: TaskDTO, issues: readonly IssueDTO[] = []): void {
  useStore.getState().hydrate({
    tasks: [t],
    activeTaskId: t.id,
    sessionTypes: [],
    issues,
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

  it('tells the user a managed worktree is removed', () => {
    installStubBridge()
    seed(task('t1', { name: 'Alpha', worktree: worktree(true) }))
    render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
    expect(screen.getByText(/removes its git worktree/)).toBeInTheDocument()
  })

  it('tells the user an adopted repo directory is left on disk (managed: false)', () => {
    installStubBridge()
    seed(task('t1', { name: 'Alpha', worktree: worktree(false) }))
    render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
    expect(screen.getByText(/repository directory is left on disk/)).toBeInTheDocument()
  })

  it('tells the user a "No Repo" task removes nothing from disk (§5.4)', () => {
    installStubBridge()
    seed(task('t1', { name: 'Scratch', repoLess: true }))
    render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
    expect(screen.getByText(/Nothing is removed from disk/)).toBeInTheDocument()
    // Not the managed/adopted wording.
    expect(screen.queryByText(/removes its git worktree/)).not.toBeInTheDocument()
    expect(screen.queryByText(/repository directory is left on disk/)).not.toBeInTheDocument()
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

  describe('bound task (connected issue)', () => {
    it('shows BoundDeleteDialog first, not the plain confirm, when no preset is given', () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
      expect(
        screen.getByRole('dialog', { name: 'Delete linked task and issue' })
      ).toBeInTheDocument()
      expect(screen.getByText(/"Alpha" is linked to issue "Fix bug"/)).toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: 'Delete Task' })).not.toBeInTheDocument()
    })

    it('"Delete issue only" dispatches issues.delete and leaves the task alone', async () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      const onClose = vi.fn()
      const onDone = vi.fn()
      render(<DeleteTaskConfirm taskId="t1" onClose={onClose} onDone={onDone} />)
      fireEvent.click(screen.getByRole('button', { name: 'Delete issue only' }))
      await waitFor(() =>
        expect(window.octopusAPI.issues.delete).toHaveBeenCalledWith({ issueId: 'i1' })
      )
      expect(window.octopusAPI.tasks.delete).not.toHaveBeenCalled()
      expect(onDone).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    it('"Delete task only" dispatches tasks.delete with no alsoDeleteIssue key (omitted-when-false)', () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Delete task only' }))
      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledWith({ taskId: 't1' })
    })

    it('"Delete both" dispatches tasks.delete with alsoDeleteIssue: true', () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Delete both' }))
      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledWith({
        taskId: 't1',
        alsoDeleteIssue: true
      })
    })

    it('cancelling the choice step closes without dispatching anything', () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      const onClose = vi.fn()
      render(<DeleteTaskConfirm taskId="t1" onClose={onClose} />)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onClose).toHaveBeenCalled()
      expect(window.octopusAPI.tasks.delete).not.toHaveBeenCalled()
      expect(window.octopusAPI.issues.delete).not.toHaveBeenCalled()
    })

    it('dirty-step round-trip preserves alsoDeleteIssue: true ("both" choice)', async () => {
      const acks: CommandAck[] = [{ ok: false, needsDirtyConfirm: true }, { ok: true }]
      let call = 0
      installStubBridge({ ack: () => acks[call++] })
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Delete both' }))
      await waitFor(() => expect(screen.getByText('Uncommitted changes')).toBeInTheDocument())
      // The also-delete-issue note survives into the dirty-step confirm body.
      expect(screen.getByText(/Its linked issue will also be deleted/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))

      await waitFor(() =>
        expect(window.octopusAPI.tasks.delete).toHaveBeenLastCalledWith({
          taskId: 't1',
          alsoDeleteIssue: true,
          confirmedDirty: true
        })
      )
    })

    it('dirty-step round-trip omits alsoDeleteIssue when false ("task only" choice)', async () => {
      const acks: CommandAck[] = [{ ok: false, needsDirtyConfirm: true }, { ok: true }]
      let call = 0
      installStubBridge({ ack: () => acks[call++] })
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Delete task only' }))
      await waitFor(() => expect(screen.getByText('Uncommitted changes')).toBeInTheDocument())
      expect(screen.queryByText(/Its linked issue will also be deleted/)).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))

      await waitFor(() =>
        expect(window.octopusAPI.tasks.delete).toHaveBeenLastCalledWith({
          taskId: 't1',
          confirmedDirty: true
        })
      )
    })

    it('dirty-step Cancel closes without re-dispatching or deleting the issue ("both" choice)', async () => {
      installStubBridge({ ack: () => ({ ok: false, needsDirtyConfirm: true }) })
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      const onClose = vi.fn()
      render(<DeleteTaskConfirm taskId="t1" onClose={onClose} />)

      fireEvent.click(screen.getByRole('button', { name: 'Delete both' }))
      await waitFor(() => expect(screen.getByText('Uncommitted changes')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledTimes(1)
      expect(window.octopusAPI.issues.delete).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    it('a Force-forget-eligible bound task falls through to the confirm step (not an immediate dispatch) and Force-forget carries alsoDeleteIssue', () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha', lifecycle: 'stale' }), [
        issue('i1', { name: 'Fix bug', taskId: 't1' })
      ])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Delete both' }))
      // Falls through to the plain confirm step instead of dispatching immediately.
      expect(window.octopusAPI.tasks.delete).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog', { name: 'Delete Task' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Force-forget' }))
      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledWith({
        taskId: 't1',
        alsoDeleteIssue: true,
        force: true
      })
    })

    it('choosing "Delete issue only" after the issue vanished mid-choice surfaces an error instead of silently doing nothing', () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} />)
      // The issue is deleted elsewhere while the choice dialog is still open.
      act(() => useStore.getState().applyEvent({ type: 'issueDeleted', issueId: 'i1' }))
      // Still shows the names captured at open, per the header comment.
      expect(screen.getByText(/"Alpha" is linked to issue "Fix bug"/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Delete issue only' }))
      expect(screen.getByRole('alert')).toHaveTextContent('That issue no longer exists')
      expect(window.octopusAPI.issues.delete).not.toHaveBeenCalled()
    })
  })

  describe('preset (caller already chose; skip the choice step)', () => {
    it('preset="task" dispatches tasks.delete once on mount with no alsoDeleteIssue key', () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} preset="task" />)
      expect(
        screen.queryByRole('dialog', { name: 'Delete linked task and issue' })
      ).not.toBeInTheDocument()
      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledTimes(1)
      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledWith({ taskId: 't1' })
    })

    it('preset="both" dispatches tasks.delete once on mount with alsoDeleteIssue: true', () => {
      installStubBridge()
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} preset="both" />)
      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledTimes(1)
      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledWith({
        taskId: 't1',
        alsoDeleteIssue: true
      })
    })

    it('preset="both" still escalates to the dirty step when the mount-time dispatch needs it, and "Delete anyway" carries alsoDeleteIssue through', async () => {
      const acks: CommandAck[] = [{ ok: false, needsDirtyConfirm: true }, { ok: true }]
      let call = 0
      installStubBridge({ ack: () => acks[call++] })
      seed(task('t1', { name: 'Alpha' }), [issue('i1', { name: 'Fix bug', taskId: 't1' })])
      render(<DeleteTaskConfirm taskId="t1" onClose={vi.fn()} preset="both" />)

      // The choice step was skipped (preset), but the dirty step still shows up.
      await waitFor(() => expect(screen.getByText('Uncommitted changes')).toBeInTheDocument())
      expect(screen.getByText(/Its linked issue will also be deleted/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))

      await waitFor(() =>
        expect(window.octopusAPI.tasks.delete).toHaveBeenLastCalledWith({
          taskId: 't1',
          alsoDeleteIssue: true,
          confirmedDirty: true
        })
      )
    })
  })
})
