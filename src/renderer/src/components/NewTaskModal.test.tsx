import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { installStubBridge } from '../test-support/stub-bridge'
import { NewTaskModal } from './NewTaskModal'
import { useStore, initialData } from '../store/store'
import type {
  IssueDTO,
  ProjectDTO,
  ProjectListItemDTO,
  ProjectWorktreeDTO
} from '../../../shared/dto'

const PROJECT_APP: ProjectListItemDTO = { path: '/repos/app', defaultBranch: 'main', taskCount: 0 }
const PROJECT_OTHER: ProjectListItemDTO = {
  path: '/repos/other',
  defaultBranch: 'develop',
  taskCount: 2
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('<NewTaskModal>', () => {
  let emit: ReturnType<typeof installStubBridge>['emit']

  beforeEach(() => {
    const bridge = installStubBridge()
    emit = bridge.emit
  })

  it('prefills the new branch from the task name until edited', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    fill('task name', 'My Feature')
    expect(screen.getByLabelText('new branch')).toHaveValue('my_feature')

    // Editing the branch freezes it against further name changes.
    fill('new branch', 'custom/branch')
    fill('task name', 'Another Name')
    expect(screen.getByLabelText('new branch')).toHaveValue('custom/branch')
  })

  // ── Projects sidebar: load, empty state, selection ──────────────────────────

  it('preselects nothing and keeps Create disabled on the New Worktree tab', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP, PROJECT_OTHER])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    // Scoped to the Projects listbox: the unrelated "Associated issue" <select>'s
    // native "None" option is also `role="option"` and selected by default, which
    // would otherwise make this assertion a false negative.
    const projectList = screen.getByRole('listbox', { name: 'Projects' })
    expect(within(projectList).queryByRole('option', { selected: true })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled()
  })

  it('keeps Create disabled with every other field filled until a project is picked', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fill('task name', 'Feature')
    fill('source branch', 'main')
    fill('new branch', 'feature/x')
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled()

    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeEnabled()
  })

  it('shows an empty-state hint when there are no configured projects', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([])
    render(<NewTaskModal onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('No projects yet')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled()
  })

  // ── Add project ──────────────────────────────────────────────────────────────

  it('does nothing when the add-project picker is cancelled', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([])
    window.octopusAPI.dialog.pickDirectory = vi.fn().mockResolvedValue(undefined)
    const add = vi.fn()
    window.octopusAPI.projects.add = add
    render(<NewTaskModal onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('No projects yet')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }))
    await waitFor(() => expect(window.octopusAPI.dialog.pickDirectory).toHaveBeenCalled())
    expect(add).not.toHaveBeenCalled()
  })

  it('shows an inline error when adding a project fails', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([])
    window.octopusAPI.dialog.pickDirectory = vi.fn().mockResolvedValue('/not/a/repo')
    window.octopusAPI.projects.add = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'not a git repository' })
    render(<NewTaskModal onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('No projects yet')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not a git repository'))
  })

  it('selects the returned project after a successful add', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([])
    window.octopusAPI.dialog.pickDirectory = vi.fn().mockResolvedValue('/repos/new')
    window.octopusAPI.projects.add = vi.fn().mockResolvedValue({
      ok: true,
      project: { path: '/repos/new', defaultBranch: 'trunk' }
    })
    render(<NewTaskModal onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('No projects yet')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }))
    await waitFor(() => expect(screen.getByLabelText('source branch')).toHaveValue('trunk'))
  })

  it('refetches the project list after a successful add, and the new row appears', async () => {
    const added: ProjectListItemDTO = { path: '/repos/new', defaultBranch: 'trunk', taskCount: 0 }
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([added])
    window.octopusAPI.projects.list = list
    window.octopusAPI.dialog.pickDirectory = vi.fn().mockResolvedValue('/repos/new')
    window.octopusAPI.projects.add = vi.fn().mockResolvedValue({
      ok: true,
      project: { path: '/repos/new', defaultBranch: 'trunk' }
    })
    render(<NewTaskModal onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('No projects yet')).toBeInTheDocument())
    expect(list).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('option', { name: 'new' })).toBeInTheDocument()
  })

  // ── Remove project ───────────────────────────────────────────────────────────

  it('shows the ack error inline and refetches when remove is stale', async () => {
    const list = vi.fn().mockResolvedValue([PROJECT_APP])
    window.octopusAPI.projects.list = list
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    expect(list).toHaveBeenCalledTimes(1)

    window.octopusAPI.projects.remove = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Project has 1 task(s); delete them first' })
    fireEvent.click(screen.getByRole('button', { name: 'remove project app' }))
    fireEvent.click(screen.getByRole('button', { name: 'confirm remove project app' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('delete them first'))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('removing the selected project clears the selection', async () => {
    const list = vi.fn().mockResolvedValueOnce([PROJECT_APP]).mockResolvedValueOnce([])
    window.octopusAPI.projects.list = list
    window.octopusAPI.projects.remove = vi.fn().mockResolvedValue({ ok: true })
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('task name', 'Feature')
    fill('new branch', 'feature/x')
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'remove project app' }))
    fireEvent.click(screen.getByRole('button', { name: 'confirm remove project app' }))
    await waitFor(() => expect(screen.getByText('No projects yet')).toBeInTheDocument())
    expect(screen.getByText('Select a project in the sidebar.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled()
  })

  // ── Existing-repo worktrees ───────────────────────────────────────────────────

  it('disables worktrees already in use by another task, with their label', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    window.octopusAPI.projects.listWorktrees = vi.fn().mockResolvedValue([
      { path: '/repos/app', branch: 'main' },
      { path: '/repos/app-wt1', branch: 'feature/x', usedByTaskName: 'Other Task' }
    ])
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))

    const used = await screen.findByRole('radio', {
      name: '/repos/app-wt1 (feature/x) — in use by Other Task'
    })
    expect(used).toBeDisabled()
    expect(screen.getByRole('radio', { name: '/repos/app (main)' })).toBeEnabled()
  })

  it('splits worktrees into an Available section first, then Used', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    window.octopusAPI.projects.listWorktrees = vi.fn().mockResolvedValue([
      { path: '/repos/app-wt1', branch: 'feature/x', usedByTaskName: 'Other Task' },
      { path: '/repos/app', branch: 'main' },
      { path: '/repos/app-wt2', branch: 'feature/y' }
    ])
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))

    const available = await screen.findByRole('group', { name: 'Available' })
    const used = screen.getByRole('group', { name: 'Used' })
    // Available is rendered before Used, each with its visible label.
    expect(available.compareDocumentPosition(used) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(available).getByText('Available')).toBeInTheDocument()
    expect(within(used).getByText('Used')).toBeInTheDocument()
    expect(
      within(available)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.title)
    ).toEqual(['/repos/app', '/repos/app-wt2'])
    expect(within(used).getAllByRole('radio')).toHaveLength(1)
    expect(within(used).getByRole('radio').closest('label')).toHaveAttribute(
      'title',
      '/repos/app-wt1 — in use by Other Task'
    )
  })

  it.each([
    ['Used', [{ path: '/repos/app', branch: 'main' }], 'Available'],
    ['Available', [{ path: '/repos/app', branch: 'main', usedByTaskName: 'T' }], 'Used']
  ])('hides the empty %s section (label included)', async (hidden, list, shown) => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    window.octopusAPI.projects.listWorktrees = vi.fn().mockResolvedValue(list)
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))

    expect(await screen.findByRole('group', { name: shown })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: hidden })).not.toBeInTheDocument()
    expect(screen.queryByText(hidden)).not.toBeInTheDocument()
  })

  // ── No Repo hides the sidebar ─────────────────────────────────────────────────

  it('hides the sidebar on the No Repo tab', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('tab', { name: 'No Repo' }))
    expect(screen.queryByRole('listbox', { name: 'Projects' })).not.toBeInTheDocument()
  })

  // ── Source branch prefill ────────────────────────────────────────────────────

  it('re-prefills the source branch when the selected project changes', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP, PROJECT_OTHER])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    expect(screen.getByLabelText('source branch')).toHaveValue('main')
    fireEvent.click(screen.getByRole('option', { name: 'other' }))
    expect(screen.getByLabelText('source branch')).toHaveValue('develop')
  })

  it('switching to a project with no default branch clears the source branch', async () => {
    const bare: ProjectListItemDTO = { path: '/repos/bare', taskCount: 0 }
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP, bare])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    expect(screen.getByLabelText('source branch')).toHaveValue('main')
    fireEvent.click(screen.getByRole('option', { name: 'bare' }))
    expect(screen.getByLabelText('source branch')).toHaveValue('')
  })

  it('editing the source branch never calls setDefaultBranch, even after submitting', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    const setDefaultBranch = vi.fn().mockResolvedValue({ ok: true })
    window.octopusAPI.projects.setDefaultBranch = setDefaultBranch
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('source branch', 'custom-branch')
    expect(screen.getByLabelText('source branch')).toHaveValue('custom-branch')
    expect(setDefaultBranch).not.toHaveBeenCalled()

    fill('task name', 'Feature')
    fill('new branch', 'feature/x')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(window.octopusAPI.tasks.create).toHaveBeenCalled())
    expect(setDefaultBranch).not.toHaveBeenCalled()
  })

  it('keeps an edited source branch when switching tabs away and back', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('source branch', 'custom')
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    fireEvent.click(screen.getByRole('tab', { name: 'From New Worktree' }))
    expect(screen.getByLabelText('source branch')).toHaveValue('custom')
  })

  it('fetches worktrees when switching to the Existing tab with a project already selected', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    const listWorktrees = vi.fn().mockResolvedValue([])
    window.octopusAPI.projects.listWorktrees = listWorktrees
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    expect(listWorktrees).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    await waitFor(() => expect(listWorktrees).toHaveBeenCalledWith({ projectPath: '/repos/app' }))
  })

  // ── Re-selection / double-click no-ops (added during review) ────────────────

  it('re-selecting the already-selected project is a no-op', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('source branch', 'custom')
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    expect(screen.getByLabelText('source branch')).toHaveValue('custom')
  })

  it('double-clicking the selected project default branch does not reset an edited source branch', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('source branch', 'custom')

    // A real double-click delivers two `click`s (bubbling to the row — a no-op,
    // since the project is already selected) followed by a `dblclick` (handled
    // by the EditableLabel itself, which does not bubble into the row).
    const branchLabel = screen.getByText('main')
    fireEvent.click(branchLabel)
    fireEvent.click(branchLabel)
    fireEvent.doubleClick(branchLabel)

    expect(screen.getByLabelText('source branch')).toHaveValue('custom')
    expect(screen.getByRole('option', { name: 'app' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('edit default branch for app')).toBeInTheDocument()
  })

  it('double-clicking the selected project default branch does not reset the chosen worktree', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    const listWorktrees = vi.fn().mockResolvedValue([
      { path: '/repos/app', branch: 'main' },
      { path: '/repos/app-wt1', branch: 'feature/x' }
    ])
    window.octopusAPI.projects.listWorktrees = listWorktrees
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    const radio = await screen.findByRole('radio', { name: '/repos/app-wt1 (feature/x)' })
    fireEvent.click(radio)
    expect(listWorktrees).toHaveBeenCalledTimes(1)

    const branchLabel = screen.getByText('main')
    fireEvent.click(branchLabel)
    fireEvent.click(branchLabel)
    fireEvent.doubleClick(branchLabel)

    expect(radio).toBeChecked()
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('editing a project default branch inline calls setDefaultBranch, refetches the list, and surfaces a failed ack as an alert', async () => {
    const list = vi.fn().mockResolvedValue([PROJECT_APP])
    window.octopusAPI.projects.list = list
    const setDefaultBranch = vi.fn().mockResolvedValue({ ok: false, error: 'bad branch name' })
    window.octopusAPI.projects.setDefaultBranch = setDefaultBranch
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    expect(list).toHaveBeenCalledTimes(1)

    const branchLabel = screen.getByText('main')
    fireEvent.doubleClick(branchLabel)
    const input = screen.getByLabelText('edit default branch for app')
    fireEvent.change(input, { target: { value: 'develop' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(setDefaultBranch).toHaveBeenCalledWith({ path: '/repos/app', defaultBranch: 'develop' })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('bad branch name'))
  })

  it('retries listWorktrees when re-clicking the selected project after a failed fetch', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    const listWorktrees = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ path: '/repos/app', branch: 'main' }])
    window.octopusAPI.projects.listWorktrees = listWorktrees
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'))

    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    await waitFor(() => expect(listWorktrees).toHaveBeenCalledTimes(2))
    await screen.findByRole('radio', { name: '/repos/app (main)' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // ── Enter handling ────────────────────────────────────────────────────────────

  it('Enter on a focused project row selects it without submitting; Enter in a text input submits', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fill('task name', 'Feature')
    fill('new branch', 'feature/x')

    const row = screen.getByRole('option', { name: 'app' })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(window.octopusAPI.tasks.create).not.toHaveBeenCalled()

    // Now every required field is filled (sourceBranch was prefilled by the
    // selection above) — Enter in a text input submits.
    fireEvent.keyDown(screen.getByLabelText('task name'), { key: 'Enter' })
    await waitFor(() => expect(window.octopusAPI.tasks.create).toHaveBeenCalled())
  })

  it('stops a session-cycle chord (Ctrl+Shift+ArrowRight) typed in the task-name field from reaching the window', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByLabelText('task name'), {
        code: 'ArrowRight',
        key: 'ArrowRight',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('stops a close-session chord (Ctrl+Shift+KeyW) typed in the task-name field from reaching the window', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByLabelText('task name'), {
        code: 'KeyW',
        key: 'w',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('Enter on the sidebar delete button or Cancel never submits, even when the form is submittable', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('task name', 'Feature')
    fill('new branch', 'feature/x')
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeEnabled()

    fireEvent.keyDown(screen.getByRole('button', { name: 'remove project app' }), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })
    expect(window.octopusAPI.tasks.create).not.toHaveBeenCalled()

    // Positive control: Enter in a text input does submit.
    fireEvent.keyDown(screen.getByLabelText('new branch'), { key: 'Enter' })
    expect(window.octopusAPI.tasks.create).toHaveBeenCalledTimes(1)
  })

  // ── Stale worktree response ───────────────────────────────────────────────────

  it('ignores a stale listWorktrees response when the project changes before it resolves', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP, PROJECT_OTHER])
    const resolvers: Array<(list: ProjectWorktreeDTO[]) => void> = []
    window.octopusAPI.projects.listWorktrees = vi.fn(
      () => new Promise<ProjectWorktreeDTO[]>((resolve) => resolvers.push(resolve))
    )
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    await screen.findByRole('option', { name: 'app' })

    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fireEvent.click(screen.getByRole('option', { name: 'other' }))
    expect(resolvers).toHaveLength(2)

    // Resolve A (now stale) last; its response must be dropped.
    await act(async () => resolvers[0]([{ path: '/repos/app-wt1', branch: 'a' }]))
    expect(screen.queryByText('/repos/app-wt1 (a)')).not.toBeInTheDocument()

    await act(async () => resolvers[1]([{ path: '/repos/other-wt1', branch: 'b' }]))
    expect(await screen.findByRole('radio', { name: '/repos/other-wt1 (b)' })).toBeInTheDocument()
  })

  // ── StrictMode ────────────────────────────────────────────────────────────────

  it('loads the project list and supports the add flow under <StrictMode>', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    window.octopusAPI.dialog.pickDirectory = vi.fn().mockResolvedValue('/repos/new')
    const added: ProjectDTO = { path: '/repos/new', defaultBranch: 'trunk' }
    window.octopusAPI.projects.add = vi.fn().mockResolvedValue({ ok: true, project: added })

    render(
      <StrictMode>
        <NewTaskModal onClose={vi.fn()} />
      </StrictMode>
    )
    expect(await screen.findByRole('option', { name: 'app' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }))
    await waitFor(() =>
      expect(window.octopusAPI.projects.add).toHaveBeenCalledWith({ dir: '/repos/new' })
    )
    await waitFor(() => expect(screen.getByLabelText('source branch')).toHaveValue('trunk'))
  })

  // ── Submitted payload ─────────────────────────────────────────────────────────

  it('submits the new-worktree payload with repoDir from the selected project', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    const onClose = vi.fn()
    render(<NewTaskModal onClose={onClose} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('task name', 'Feature')
    fill('new branch', 'feature/x')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
      mode: 'new',
      name: 'Feature',
      repoDir: '/repos/app',
      sourceBranch: 'main',
      newBranch: 'feature/x'
    })

    emit({ type: 'activeTaskChanged', taskId: 'task-1' })
    expect(onClose).toHaveBeenCalled()
  })

  it('submits the existing-repo payload with worktreeDir from the selected worktree', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    window.octopusAPI.projects.listWorktrees = vi.fn().mockResolvedValue([
      { path: '/repos/app', branch: 'main' },
      { path: '/repos/app-wt1', branch: 'feature/x' }
    ])
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    const radio = await screen.findByRole('radio', { name: '/repos/app-wt1 (feature/x)' })
    fireEvent.click(radio)
    fill('task name', 'Adopted')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
      mode: 'existing',
      name: 'Adopted',
      worktreeDir: '/repos/app-wt1'
    })
  })

  // ── Provisioning outcome via the event stream (unchanged by this feature) ────

  it('shows the stderr inline and offers Retry on scriptError', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    const onClose = vi.fn()
    render(<NewTaskModal onClose={onClose} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('task name', 'Feature')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(window.octopusAPI.tasks.create).toHaveBeenCalled())

    emit({
      type: 'scriptError',
      taskId: 'task-1',
      script: 'create_worktree',
      exitCode: 1,
      stderr: 'fatal: branch already exists'
    })

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('fatal: branch already exists')
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('surfaces live scriptProgress while provisioning', async () => {
    window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
    render(<NewTaskModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'app' })
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    fill('task name', 'Feature')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(window.octopusAPI.tasks.create).toHaveBeenCalled())

    emit({ type: 'scriptProgress', taskId: 'task-1', line: 'Preparing worktree' })
    await waitFor(() => expect(screen.getByText('Preparing worktree')).toBeInTheDocument())
  })

  // ── Associated issue picker + "Create task" prefill (PRD "Issues") ───────────

  describe('associated issue', () => {
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

    function seedIssues(...list: IssueDTO[]): void {
      useStore.setState({ issues: Object.fromEntries(list.map((i) => [i.id, i])) })
    }

    /** Opens the "Associated issue" dropdown and returns its entries ("None" first). */
    function pickerOptions(): HTMLElement[] {
      fireEvent.click(screen.getByLabelText('associated issue'))
      return within(screen.getByRole('listbox', { name: 'Issues' })).getAllByRole('option')
    }

    /** Picks issue `id` (or "None" for `''`) through the dropdown, like a user would. */
    function pickIssue(id: string): void {
      const label = id === '' ? 'None' : useStore.getState().issues[id].name
      const entry = pickerOptions().find((o) => o.textContent?.startsWith(label))
      if (!entry) throw new Error(`no picker entry for "${label}"`)
      fireEvent.click(entry)
    }

    beforeEach(() => {
      useStore.setState(initialData())
    })

    afterEach(() => {
      useStore.setState(initialData())
    })

    it('lists not-Done issues newest first with their status icon; bound ones are disabled', () => {
      seedIssues(
        issue('old', { name: 'Old', createdAt: 1000 }),
        issue('new', { name: 'New', status: 'in_progress', createdAt: 3000 }),
        issue('done', { name: 'Finished', status: 'done', createdAt: 4000 }),
        issue('bound', { name: 'Bound', createdAt: 2000, taskId: 't9' })
      )
      render(<NewTaskModal onClose={vi.fn()} />)
      const options = pickerOptions()
      expect(options.map((o) => o.textContent)).toEqual([
        'None',
        'New',
        'Bound(already linked)',
        'Old'
      ])
      // The same SVG status icon as the issue window, not a text glyph.
      expect(within(options[1]).getByRole('img', { name: 'In progress' })).toHaveAttribute(
        'data-status',
        'in_progress'
      )
      expect(options[1].querySelector('svg')).not.toBeNull()
      expect(within(options[3]).getByRole('img', { name: 'Todo' })).toBeInTheDocument()
      expect(options[2]).toBeDisabled()
      expect(options[1]).toBeEnabled()
      expect(options[3]).toBeEnabled()
      // Every entry is left-aligned, overriding the global `button` centering.
      for (const o of options) expect(o.style.justifyContent).toBe('flex-start')
      expect(screen.getByLabelText('associated issue')).toHaveAttribute('data-value', '')
    })

    it('the closed picker shows the picked issue with its status icon', () => {
      seedIssues(issue('i1', { name: 'Fix login bug', status: 'in_review' }))
      render(<NewTaskModal onClose={vi.fn()} />)
      const trigger = screen.getByLabelText('associated issue')
      expect(trigger).toHaveTextContent('None')

      pickIssue('i1')
      expect(screen.queryByRole('listbox', { name: 'Issues' })).not.toBeInTheDocument()
      expect(trigger).toHaveAttribute('data-value', 'i1')
      expect(trigger).toHaveTextContent('Fix login bug')
      expect(within(trigger).getByRole('img', { name: 'In review' })).toBeInTheDocument()
    })

    it('Escape in the open picker closes only the picker, not the modal', () => {
      seedIssues(issue('i1'))
      const onClose = vi.fn()
      render(<NewTaskModal onClose={onClose} />)
      pickerOptions()
      const listbox = screen.getByRole('listbox', { name: 'Issues' })

      fireEvent.keyDown(listbox, { key: 'Escape' })
      expect(screen.queryByRole('listbox', { name: 'Issues' })).not.toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByLabelText('associated issue')).toHaveFocus()
    })

    it('arrow keys move between pickable entries, skipping disabled ones', () => {
      seedIssues(
        issue('a', { name: 'A', createdAt: 3000 }),
        issue('b', { name: 'B', createdAt: 2000, taskId: 't9' }),
        issue('c', { name: 'C', createdAt: 1000 })
      )
      render(<NewTaskModal onClose={vi.fn()} />)
      const [none, a, , c] = pickerOptions()
      expect(none).toHaveFocus() // nothing picked yet → "None" is the current entry
      const listbox = screen.getByRole('listbox', { name: 'Issues' })
      fireEvent.keyDown(listbox, { key: 'ArrowDown' })
      expect(a).toHaveFocus()
      fireEvent.keyDown(listbox, { key: 'ArrowDown' })
      expect(c).toHaveFocus() // B is already linked → skipped
      fireEvent.keyDown(listbox, { key: 'ArrowUp' })
      expect(a).toHaveFocus()
    })

    it('an outside mousedown closes the open picker without picking', () => {
      seedIssues(issue('i1'))
      render(<NewTaskModal onClose={vi.fn()} />)
      pickerOptions()
      fireEvent.mouseDown(screen.getByLabelText('task name'))
      expect(screen.queryByRole('listbox', { name: 'Issues' })).not.toBeInTheDocument()
      expect(screen.getByLabelText('associated issue')).toHaveAttribute('data-value', '')
    })

    it("picking an issue fills an empty name + branch and selects the issue's project", async () => {
      window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP, PROJECT_OTHER])
      seedIssues(issue('i1', { name: 'Fix login bug', projectPath: '/repos/other' }))
      render(<NewTaskModal onClose={vi.fn()} />)
      await screen.findByRole('option', { name: 'other' })

      pickIssue('i1')
      expect(screen.getByLabelText('task name')).toHaveValue('Fix login bug')
      expect(screen.getByLabelText('new branch')).toHaveValue('fix_login_bug')
      expect(screen.getByRole('option', { name: 'other' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByLabelText('source branch')).toHaveValue('develop')
    })

    it('picking an issue keeps a typed name and an already-selected project', async () => {
      window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP, PROJECT_OTHER])
      seedIssues(issue('i1', { name: 'Fix login bug', projectPath: '/repos/other' }))
      render(<NewTaskModal onClose={vi.fn()} />)
      await screen.findByRole('option', { name: 'app' })
      fireEvent.click(screen.getByRole('option', { name: 'app' }))
      fill('task name', 'My own name')

      pickIssue('i1')
      expect(screen.getByLabelText('task name')).toHaveValue('My own name')
      expect(screen.getByRole('option', { name: 'app' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('option', { name: 'other' })).toHaveAttribute(
        'aria-selected',
        'false'
      )
    })

    it('submits issueId with the new-worktree payload when an issue is picked', async () => {
      window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
      seedIssues(issue('i1', { name: 'Fix login bug' }))
      render(<NewTaskModal onClose={vi.fn()} />)
      await screen.findByRole('option', { name: 'app' })
      fireEvent.click(screen.getByRole('option', { name: 'app' }))
      pickIssue('i1')
      fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
      expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
        mode: 'new',
        name: 'Fix login bug',
        repoDir: '/repos/app',
        sourceBranch: 'main',
        newBranch: 'fix_login_bug',
        issueId: 'i1'
      })
    })

    it('submits issueId with the no-repo payload when an issue is picked', async () => {
      seedIssues(issue('i1', { name: 'Scratch issue' }))
      render(<NewTaskModal onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('tab', { name: 'No Repo' }))
      pickIssue('i1')
      fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
      expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
        mode: 'none',
        name: 'Scratch issue',
        issueId: 'i1'
      })
    })

    it('submits issueId with the existing-repo payload when an issue is picked', async () => {
      window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
      window.octopusAPI.projects.listWorktrees = vi.fn().mockResolvedValue([
        { path: '/repos/app', branch: 'main' },
        { path: '/repos/app-wt1', branch: 'feature/x' }
      ])
      seedIssues(issue('i1', { name: 'Fix login bug' }))
      render(<NewTaskModal onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
      await screen.findByRole('option', { name: 'app' })
      fireEvent.click(screen.getByRole('option', { name: 'app' }))
      const radio = await screen.findByRole('radio', { name: '/repos/app-wt1 (feature/x)' })
      fireEvent.click(radio)
      pickIssue('i1')
      fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
      expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
        mode: 'existing',
        name: 'Fix login bug',
        worktreeDir: '/repos/app-wt1',
        issueId: 'i1'
      })
    })

    it('clearing the picker back to None keeps the filled name and omits issueId', async () => {
      seedIssues(issue('i1', { name: 'Scratch issue' }))
      render(<NewTaskModal onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('tab', { name: 'No Repo' }))
      pickIssue('i1')
      pickIssue('')
      expect(screen.getByLabelText('task name')).toHaveValue('Scratch issue')
      fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
      expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
        mode: 'none',
        name: 'Scratch issue'
      })
    })

    it('fromIssueId locks the picker and prefills name, project, and branch', async () => {
      window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP, PROJECT_OTHER])
      seedIssues(issue('i1', { name: 'Fix login bug', projectPath: '/repos/other' }))
      render(<NewTaskModal onClose={vi.fn()} fromIssueId="i1" />)

      const picker = screen.getByLabelText('associated issue')
      expect(picker).toBeDisabled()
      await waitFor(() => expect(picker).toHaveAttribute('data-value', 'i1'))
      expect(screen.getByLabelText('task name')).toHaveValue('Fix login bug')
      expect(screen.getByRole('tab', { name: 'From New Worktree' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'other' })).toHaveAttribute(
          'aria-selected',
          'true'
        )
      )
      expect(screen.getByLabelText('source branch')).toHaveValue('develop')
      expect(screen.getByLabelText('new branch')).toHaveValue('fix_login_bug')

      fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
      expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
        mode: 'new',
        name: 'Fix login bug',
        repoDir: '/repos/other',
        sourceBranch: 'develop',
        newBranch: 'fix_login_bug',
        issueId: 'i1'
      })
    })

    it("fromIssueId leaves the project unselected when the issue's project is gone", async () => {
      window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
      seedIssues(issue('i1', { name: 'Fix login bug', projectPath: '/repos/removed' }))
      render(<NewTaskModal onClose={vi.fn()} fromIssueId="i1" />)
      await screen.findByRole('option', { name: 'app' })

      await waitFor(() => expect(screen.getByLabelText('task name')).toHaveValue('Fix login bug'))
      expect(screen.getByLabelText('associated issue')).toHaveAttribute('data-value', 'i1')
      const projectList = screen.getByRole('listbox', { name: 'Projects' })
      expect(within(projectList).queryByRole('option', { selected: true })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled()
    })

    it('an unknown fromIssueId behaves as no prefill', async () => {
      window.octopusAPI.projects.list = vi.fn().mockResolvedValue([PROJECT_APP])
      seedIssues(issue('i1', { name: 'Other issue' }))
      render(<NewTaskModal onClose={vi.fn()} fromIssueId="missing" />)
      await screen.findByRole('option', { name: 'app' })

      const picker = screen.getByLabelText('associated issue')
      expect(picker).toBeEnabled()
      expect(picker).toHaveAttribute('data-value', '')
      expect(screen.getByLabelText('task name')).toHaveValue('')
    })
  })
})
