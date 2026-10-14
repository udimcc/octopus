import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { IssueDetail } from './IssueDetail'
import { IssueList } from './IssueList'
import { DiscardChangesPrompt } from './DiscardChangesPrompt'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { IssueDTO, TaskDTO, WindowedWorkspaceStateDTO } from '../../../shared/dto'

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

function task(id: string, over: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id,
    name: id,
    lifecycle: 'ready',
    state: 'unknown',
    sessions: [],
    position: 0,
    createdAt: 1000,
    groups: [],
    ...over
  }
}

function seed(issues: IssueDTO[], tasks: TaskDTO[] = []): void {
  const state: WindowedWorkspaceStateDTO = {
    tasks,
    activeTaskId: undefined,
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
  }
  useStore.getState().hydrate(state)
}

function renderDetail(
  overrides: Partial<{
    onCreateTaskFromIssue: (issueId: string) => void
    onDeleteBoundTask: (taskId: string, alsoDeleteIssue: boolean) => void
  }> = {}
): {
  onCreateTaskFromIssue: ReturnType<typeof vi.fn>
  onDeleteBoundTask: ReturnType<typeof vi.fn>
} {
  const onCreateTaskFromIssue = overrides.onCreateTaskFromIssue ?? vi.fn()
  const onDeleteBoundTask = overrides.onDeleteBoundTask ?? vi.fn()
  render(
    <IssueDetail
      onCreateTaskFromIssue={onCreateTaskFromIssue as (issueId: string) => void}
      onDeleteBoundTask={onDeleteBoundTask as (taskId: string, alsoDeleteIssue: boolean) => void}
    />
  )
  return { onCreateTaskFromIssue, onDeleteBoundTask } as never
}

/**
 * `IssueList` + `IssueDetail` + the real `DiscardChangesPrompt`, composed the same
 * way `IssuesDrawer` composes them — needed for the "click another row while
 * dirty" scenarios, which depend on the list's own `selectIssue` dispatch and the
 * prompt's real Discard/Keep-editing buttons, not a re-implementation of either.
 */
/** A controllable promise: lets a test decide exactly when an IPC reply lands. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderListAndDetail(): void {
  function Harness(): React.JSX.Element {
    const discardPrompt = useStore((s) => s.discardPrompt)
    const confirmDiscard = useStore((s) => s.confirmDiscard)
    const cancelDiscard = useStore((s) => s.cancelDiscard)
    return (
      <>
        <IssueList />
        <IssueDetail onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
        {discardPrompt ? (
          <DiscardChangesPrompt onDiscard={confirmDiscard} onKeepEditing={cancelDiscard} />
        ) : null}
      </>
    )
  }
  render(<Harness />)
}

describe('<IssueDetail>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('shows the empty-state prompt when nothing is selected and no draft is in progress', () => {
    seed([])
    renderDetail()
    expect(screen.getByText('Select an issue, or create a new one.')).toBeInTheDocument()
    expect(screen.queryByLabelText('issue name')).not.toBeInTheDocument()
  })

  it('view mode: shows name, description, project, task, status and the action buttons', () => {
    seed([issue('i1', { name: 'Fix the bug', description: 'details', status: 'in_review' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()

    expect(screen.getByRole('heading', { name: 'Fix the bug' })).toBeInTheDocument()
    expect(screen.getByText('details')).toBeInTheDocument()
    expect(screen.getByText('No project')).toBeInTheDocument()
    expect(screen.getByText('Not linked')).toBeInTheDocument()
    expect(screen.getByLabelText('issue status')).toHaveValue('in_review')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Link task' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unlink task' })).not.toBeInTheDocument()
  })

  it('the status select is usable in view mode and persists immediately', () => {
    seed([issue('i1', { status: 'todo' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()

    fireEvent.change(screen.getByLabelText('issue status'), { target: { value: 'done' } })
    expect(window.octopusAPI.issues.update).toHaveBeenCalledWith({ issueId: 'i1', status: 'done' })
  })

  it('view mode: the status/action toolbar sits above the description, not after it', () => {
    seed([issue('i1', { description: 'details' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()

    const description = screen.getByText('details')
    for (const control of [
      screen.getByLabelText('issue status'),
      screen.getByRole('button', { name: 'Edit' }),
      screen.getByRole('button', { name: 'Delete' })
    ]) {
      expect(
        control.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
  })

  it('status is changed only from the view: the edit form has no status select', () => {
    seed([issue('i1')])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('issue name')).toBeInTheDocument()
    expect(screen.queryByLabelText('issue status')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('issue status')).toBeInTheDocument()
  })

  it('form mode: Save/Cancel come right after the fields', () => {
    seed([issue('i1')])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const project = screen.getByLabelText('issue project')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(project.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The description isn't stretched to fill the pane (which pushed the buttons down).
    expect(screen.getByLabelText('issue description').closest('label')!.style.flex).toBe('')
  })

  it('clicking Edit prefills the form from the current issue', () => {
    seed([issue('i1', { name: 'Fix the bug', description: 'details' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('issue name')).toHaveValue('Fix the bug')
    expect(screen.getByLabelText('issue description')).toHaveValue('details')
  })

  it('requires a name on Edit save: Save is disabled for a blank/whitespace-only name', () => {
    seed([issue('i1', { name: 'Fix the bug' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('issue name'), { target: { value: '  ' } })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(window.octopusAPI.issues.update).not.toHaveBeenCalled()
  })

  it('saving an edit updates the issue and returns to view mode', async () => {
    seed([issue('i1', { name: 'Old name', description: 'old' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(window.octopusAPI.issues.update).toHaveBeenCalledWith({
      issueId: 'i1',
      name: 'New name',
      description: 'old',
      projectPath: null
    })
    await waitFor(() => expect(screen.queryByLabelText('issue name')).not.toBeInTheDocument())
  })

  it('shows an error and stays in edit mode when the save ack fails', async () => {
    seed([issue('i1', { name: 'Old name' })])
    installStubBridge({ ack: () => ({ ok: false, error: 'boom' }) })
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
    expect(screen.getByLabelText('issue name')).toBeInTheDocument()
  })

  it('draft mode: starts blank, and Save creates the issue then selects it', async () => {
    seed([])
    installStubBridge({ ack: () => ({ ok: true, issueId: 'new1' }) })
    act(() => useStore.getState().startNewIssue())
    renderDetail()

    expect(screen.getByLabelText('issue name')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'Brand new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(window.octopusAPI.issues.create).toHaveBeenCalledWith({
      name: 'Brand new',
      description: '',
      projectPath: undefined
    })
    await waitFor(() => expect(useStore.getState().selectedIssueId).toBe('new1'))
    expect(useStore.getState().issueDraft).toBe(false)
  })

  it('draft mode: Cancel discards directly, without a confirmation prompt', () => {
    seed([])
    act(() => useStore.getState().startNewIssue())
    renderDetail()
    fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'Typed something' } })
    expect(useStore.getState().issueEditDirty).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useStore.getState().issueDraft).toBe(false)
    expect(useStore.getState().discardPrompt).toBeNull()
  })

  describe('edit-flow dirty tracking', () => {
    it('typing in name, description or project sets issueEditDirty; reverting clears it', async () => {
      seed([issue('i1', { name: 'Fix the bug', description: 'details', projectPath: '/p' })])
      window.octopusAPI.projects.list = vi.fn().mockResolvedValue([{ path: '/p', taskCount: 0 }])
      act(() => useStore.getState().selectIssue('i1'))
      renderDetail()
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      await waitFor(() => expect(screen.getByLabelText('issue project')).toHaveValue('/p'))
      expect(useStore.getState().issueEditDirty).toBe(false)

      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'Fix the bug!' } })
      expect(useStore.getState().issueEditDirty).toBe(true)
      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'Fix the bug' } })
      expect(useStore.getState().issueEditDirty).toBe(false)

      fireEvent.change(screen.getByLabelText('issue description'), { target: { value: 'x' } })
      expect(useStore.getState().issueEditDirty).toBe(true)
      fireEvent.change(screen.getByLabelText('issue description'), { target: { value: 'details' } })
      expect(useStore.getState().issueEditDirty).toBe(false)

      fireEvent.change(screen.getByLabelText('issue project'), { target: { value: '' } })
      expect(useStore.getState().issueEditDirty).toBe(true)
      fireEvent.change(screen.getByLabelText('issue project'), { target: { value: '/p' } })
      expect(useStore.getState().issueEditDirty).toBe(false)
    })

    it('clicking another row while dirty shows the discard prompt; Discard switches and resets', () => {
      seed([issue('i1', { name: 'One' }), issue('i2', { name: 'Two' })])
      act(() => useStore.getState().selectIssue('i1'))
      renderListAndDetail()
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'One, edited' } })
      expect(useStore.getState().issueEditDirty).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: /Two/ }))
      expect(useStore.getState().discardPrompt).toEqual({ kind: 'select', issueId: 'i2' })
      expect(useStore.getState().selectedIssueId).toBe('i1') // not switched yet

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      expect(useStore.getState().selectedIssueId).toBe('i2')
      expect(useStore.getState().issueEditDirty).toBe(false)
      expect(screen.getByRole('heading', { name: 'Two' })).toBeInTheDocument()
    })

    it('clicking another row while dirty, then Keep editing, keeps the typed text and the original issue', () => {
      seed([issue('i1', { name: 'One' }), issue('i2', { name: 'Two' })])
      act(() => useStore.getState().selectIssue('i1'))
      renderListAndDetail()
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'One, edited' } })

      fireEvent.click(screen.getByRole('button', { name: /Two/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))

      expect(useStore.getState().discardPrompt).toBeNull()
      expect(useStore.getState().selectedIssueId).toBe('i1')
      expect(screen.getByLabelText('issue name')).toHaveValue('One, edited')
    })

    it('Edit, change, Cancel returns to view mode with dirty false and no update call; editing again shows the original values', () => {
      seed([issue('i1', { name: 'Old name', description: 'old' })])
      act(() => useStore.getState().selectIssue('i1'))
      renderDetail()
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'New name' } })
      expect(useStore.getState().issueEditDirty).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(useStore.getState().issueEditDirty).toBe(false)
      expect(window.octopusAPI.issues.update).not.toHaveBeenCalled()
      expect(screen.getByRole('heading', { name: 'Old name' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      expect(screen.getByLabelText('issue name')).toHaveValue('Old name')
    })

    it('clearing the project on an issue that had one sends projectPath: null', async () => {
      seed([issue('i1', { name: 'Fix the bug', projectPath: '/some/project' })])
      window.octopusAPI.projects.list = vi
        .fn()
        .mockResolvedValue([{ path: '/some/project', taskCount: 0 }])
      act(() => useStore.getState().selectIssue('i1'))
      renderDetail()
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      await waitFor(() =>
        expect(screen.getByLabelText('issue project')).toHaveValue('/some/project')
      )

      fireEvent.change(screen.getByLabelText('issue project'), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      expect(window.octopusAPI.issues.update).toHaveBeenCalledWith({
        issueId: 'i1',
        name: 'Fix the bug',
        description: '',
        projectPath: null
      })
    })
  })

  it('deletes an unbound issue via the plain confirm', async () => {
    seed([issue('i1')])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    const dialog = screen.getByRole('dialog', { name: 'Delete issue' })
    expect(dialog).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(window.octopusAPI.issues.delete).toHaveBeenCalledWith({ issueId: 'i1' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Delete issue' })).not.toBeInTheDocument()
    )
  })

  it('shows the bound-delete dialog for a bound issue, and "issue only" deletes just the issue', () => {
    seed([issue('i1', { taskId: 't1' })], [task('t1', { name: 'My task' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(screen.getByRole('dialog', { name: 'Delete linked task and issue' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete issue only' }))
    expect(window.octopusAPI.issues.delete).toHaveBeenCalledWith({ issueId: 'i1' })
  })

  it('bound-delete "task only" calls onDeleteBoundTask(taskId, false), not issues.delete', () => {
    seed([issue('i1', { taskId: 't1' })], [task('t1', { name: 'My task' })])
    act(() => useStore.getState().selectIssue('i1'))
    const { onDeleteBoundTask } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete task only' }))

    expect(onDeleteBoundTask).toHaveBeenCalledWith('t1', false)
    expect(window.octopusAPI.issues.delete).not.toHaveBeenCalled()
  })

  it('bound-delete "both" calls onDeleteBoundTask(taskId, true)', () => {
    seed([issue('i1', { taskId: 't1' })], [task('t1', { name: 'My task' })])
    act(() => useStore.getState().selectIssue('i1'))
    const { onDeleteBoundTask } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete both' }))

    expect(onDeleteBoundTask).toHaveBeenCalledWith('t1', true)
  })

  it('Create task calls onCreateTaskFromIssue when the issue is not bound', () => {
    seed([issue('i1')])
    act(() => useStore.getState().selectIssue('i1'))
    const { onCreateTaskFromIssue } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect(onCreateTaskFromIssue).toHaveBeenCalledWith('i1')
  })

  it('Create task is disabled when the issue is already bound', () => {
    seed([issue('i1', { taskId: 't1' })], [task('t1')])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
  })

  it('Link task opens the picker, which can be cancelled back', () => {
    seed([issue('i1')], [task('t1', { name: 'Alpha' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Link task' }))
    expect(screen.getByRole('dialog', { name: 'Link task' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Link task' })).not.toBeInTheDocument()
  })

  it('Unlink task only appears when bound, and unbinds on click', () => {
    seed([issue('i1', { taskId: 't1' })], [task('t1', { name: 'My task' })])
    act(() => useStore.getState().selectIssue('i1'))
    renderDetail()
    const disconnect = screen.getByRole('button', { name: 'Unlink task' })
    fireEvent.click(disconnect)
    expect(window.octopusAPI.issues.unbind).toHaveBeenCalledWith({ issueId: 'i1' })
  })

  describe('stale-IPC-reply guards (issueEditSession)', () => {
    it('a stale save-edit failure, after discarding into another issue, shows no error there, and does not disable a genuinely-busy save on i2', async () => {
      seed([issue('i1', { name: 'One' }), issue('i2', { name: 'Two' })])
      const d1 = deferred<{ ok: boolean; error?: string }>()
      const d2 = deferred<{ ok: boolean; error?: string }>()
      const update = vi.fn().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise)
      window.octopusAPI.issues.update = update
      act(() => useStore.getState().selectIssue('i1'))
      renderDetail()
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'One, edited' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(update).toHaveBeenCalledTimes(1)
      // Still busy/dirty on i1 — the request hasn't resolved yet.
      expect(useStore.getState().issueEditDirty).toBe(true)

      act(() => useStore.getState().selectIssue('i2')) // dirty -> raises discardPrompt
      expect(useStore.getState().discardPrompt).toEqual({ kind: 'select', issueId: 'i2' })
      act(() => useStore.getState().confirmDiscard()) // discards i1's edit, switches to i2
      expect(screen.getByRole('heading', { name: 'Two' })).toBeInTheDocument()

      // Start a genuine (still-pending) save on i2, so there's a real busy state
      // for the stale i1 reply to wrongly clear if the session guard were broken.
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'Two, edited' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(update).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

      await act(async () => {
        d1.resolve({ ok: false, error: 'boom' })
        await d1.promise
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      // i2 is still mid-edit (never resolved its own save), so its form — not the
      // view-mode heading — is still what's on screen.
      expect(screen.getByLabelText('issue name')).toHaveValue('Two, edited')
      // The stale i1 reply must not touch i2's own still-pending busy state.
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    })

    it('a stale status-change reply, after the selection changed, does not surface an error', async () => {
      seed([issue('i1', { status: 'todo' }), issue('i2', { status: 'todo' })])
      const d = deferred<{ ok: boolean; error?: string }>()
      window.octopusAPI.issues.update = vi.fn(() => d.promise)
      act(() => useStore.getState().selectIssue('i1'))
      renderDetail()
      fireEvent.change(screen.getByLabelText('issue status'), { target: { value: 'done' } })
      expect(window.octopusAPI.issues.update).toHaveBeenCalledTimes(1)

      act(() => useStore.getState().selectIssue('i2')) // clean (not dirty) -> switches immediately
      await act(async () => {
        d.resolve({ ok: false, error: 'boom' })
        await d.promise
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it("a stale draft-create success, after a new draft was started in its place, does not select the old reply's issue", async () => {
      seed([])
      const d = deferred<{ ok: boolean; issueId?: string }>()
      window.octopusAPI.issues.create = vi.fn(() => d.promise)
      act(() => useStore.getState().startNewIssue())
      renderDetail()
      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'Brand new' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(window.octopusAPI.issues.create).toHaveBeenCalledTimes(1)
      // issueDraft stays dirty (not yet cleared) while the create is in flight, so
      // starting another draft is dirty-guarded and goes through the discard prompt,
      // same as switching issues.
      act(() => useStore.getState().startNewIssue())
      expect(useStore.getState().discardPrompt).toEqual({ kind: 'new' })
      act(() => useStore.getState().confirmDiscard())

      await act(async () => {
        d.resolve({ ok: true, issueId: 'new1' })
        await d.promise
      })
      expect(useStore.getState().selectedIssueId).not.toBe('new1')
      expect(useStore.getState().issueDraft).toBe(true)
    })

    // The Cancel button is `disabled={formBusy}` while the create request is in
    // flight, so the real UI can't reach this race; dispatch `cancelNewIssue()`
    // directly to probe the store's `issueEditSession` bump that guards it.
    it('a stale draft-create success after Cancel does not select the created issue', async () => {
      // Dispatches `cancelNewIssue()` directly (bypassing the disabled Cancel button)
      // to probe the guard itself.
      seed([])
      const d = deferred<{ ok: boolean; issueId?: string }>()
      window.octopusAPI.issues.create = vi.fn(() => d.promise)
      act(() => useStore.getState().startNewIssue())
      renderDetail()
      fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'Brand new' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(window.octopusAPI.issues.create).toHaveBeenCalledTimes(1)

      act(() => useStore.getState().cancelNewIssue())
      expect(useStore.getState().issueDraft).toBe(false)

      await act(async () => {
        d.resolve({ ok: true, issueId: 'new1' })
        await d.promise
      })
      expect(useStore.getState().selectedIssueId).not.toBe('new1')
    })

    it('a stale unlink failure, after switching to another issue, does not surface an error or leave it busy there', async () => {
      seed(
        [issue('i1', { name: 'One', taskId: 't1' }), issue('i2', { name: 'Two' })],
        [task('t1', { name: 'My task' })]
      )
      const d = deferred<{ ok: boolean; error?: string }>()
      window.octopusAPI.issues.unbind = vi.fn(() => d.promise)
      act(() => useStore.getState().selectIssue('i1'))
      renderDetail()
      fireEvent.click(screen.getByRole('button', { name: 'Unlink task' }))
      expect(window.octopusAPI.issues.unbind).toHaveBeenCalledWith({ issueId: 'i1' })

      // Unlinking doesn't set issueEditDirty, so switching away is immediate,
      // no discard prompt — same as the status-change case above.
      act(() => useStore.getState().selectIssue('i2'))
      expect(screen.getByRole('heading', { name: 'Two' })).toBeInTheDocument()

      await act(async () => {
        d.reject(new Error('boom'))
        await d.promise.catch(() => {})
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      // i2 is unbound and never itself called `unlink` — the stale i1 rejection
      // must not have left `actionBusy` stuck true for it.
      expect(screen.getByRole('button', { name: 'Link task' })).not.toBeDisabled()
    })

    it("a stale delete failure, after switching to another issue, does not corrupt that issue's OWN freshly-opened delete dialog", async () => {
      // `deleteBusy`/`deleteError` only ever render inside whichever delete dialog
      // is currently mounted — and the reset effect already unmounts i1's dialog
      // the moment the selection changes, regardless of this guard. So the only
      // way the guard is actually load-bearing is if i2 opens its OWN fresh dialog
      // before the stale i1 reply lands: without the guard, the stale rejection
      // would land in i2's dialog instead.
      seed([issue('i1', { name: 'One' }), issue('i2', { name: 'Two' })])
      const d1 = deferred<{ ok: boolean; error?: string }>()
      const d2 = deferred<{ ok: boolean; error?: string }>()
      const del = vi.fn().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise)
      window.octopusAPI.issues.delete = del
      act(() => useStore.getState().selectIssue('i1'))
      renderDetail()
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Delete issue' })).getByRole('button', {
          name: 'Delete'
        })
      )
      expect(del).toHaveBeenCalledTimes(1)

      // Deleting doesn't set issueEditDirty, so this switch is immediate — and it
      // bumps issueEditSession, which the reset effect uses to drop i1's dialog.
      act(() => useStore.getState().selectIssue('i2'))
      expect(screen.queryByRole('dialog', { name: 'Delete issue' })).not.toBeInTheDocument()

      // i2 opens its own, genuinely in-flight, delete.
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      const i2Dialog = screen.getByRole('dialog', { name: 'Delete issue' })
      fireEvent.click(within(i2Dialog).getByRole('button', { name: 'Delete' }))
      expect(del).toHaveBeenCalledTimes(2)
      expect(within(i2Dialog).getByRole('button', { name: 'Delete' })).toBeDisabled()

      await act(async () => {
        d1.reject(new Error('boom'))
        await d1.promise.catch(() => {})
      })
      // The stale i1 rejection must not have touched i2's genuinely-open dialog.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(within(i2Dialog).getByRole('button', { name: 'Delete' })).toBeDisabled()
    })
  })

  it("edit i1 dirty, close+discard, then open directly onto i2: view mode with i2's own values", () => {
    seed([issue('i1', { name: 'One' }), issue('i2', { name: 'Two', description: 'two-desc' })])
    act(() => {
      useStore.getState().toggleIssuesDrawer() // open
      useStore.getState().selectIssue('i1')
    })
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('issue name'), { target: { value: 'One, edited' } })
    expect(useStore.getState().issueEditDirty).toBe(true)

    act(() => useStore.getState().toggleIssuesDrawer()) // close while dirty -> raises discardPrompt
    expect(useStore.getState().discardPrompt).toEqual({ kind: 'close' })
    act(() => useStore.getState().confirmDiscard()) // discards and closes

    act(() => useStore.getState().openIssuesDrawer('i2'))
    expect(screen.queryByLabelText('issue name')).not.toBeInTheDocument() // view mode, not editing
    expect(screen.getByRole('heading', { name: 'Two' })).toBeInTheDocument()
    expect(screen.getByText('two-desc')).toBeInTheDocument()
  })
})
