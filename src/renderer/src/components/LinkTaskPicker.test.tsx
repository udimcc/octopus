import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { LinkTaskPicker } from './LinkTaskPicker'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { IssueDTO, TaskDTO, WindowedWorkspaceStateDTO } from '../../../shared/dto'

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

/** A worktree DTO stub whose only load-bearing field is the repo root. */
function worktree(repoRoot: string): TaskDTO['worktree'] {
  return {
    path: `${repoRoot}/wt`,
    managed: true,
    provisionedBy: { script: '', args: [], repoRoot, provisionedAt: 0 }
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
    source: 'local',
    ...over
  }
}

function seed(tasks: TaskDTO[], issues: IssueDTO[]): void {
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

describe('<LinkTaskPicker>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
  })

  it('shows "No tasks yet." when there are none', () => {
    seed([], [issue('i1')])
    installStubBridge()
    render(<LinkTaskPicker issueId="i1" onClose={vi.fn()} />)
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument()
  })

  it('lists every task by name', () => {
    seed([task('t1', { name: 'Alpha' }), task('t2', { name: 'Beta' })], [issue('i1')])
    installStubBridge()
    render(<LinkTaskPicker issueId="i1" onClose={vi.fn()} />)
    expect(screen.getByRole('option', { name: /^Alpha/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^Beta/ })).toBeInTheDocument()
  })

  it('marks the task already bound to THIS issue as "current" and selectable', () => {
    seed([task('t1', { name: 'Alpha' })], [issue('i1', { taskId: 't1' })])
    installStubBridge()
    render(<LinkTaskPicker issueId="i1" onClose={vi.fn()} />)
    const row = screen.getByRole('option', { name: /^Alpha/ })
    expect(row).toHaveTextContent('current')
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(row).not.toBeDisabled()
  })

  it('disables a task already bound to a DIFFERENT issue, as "already linked"', () => {
    seed([task('t1', { name: 'Alpha' })], [issue('i1'), issue('i2', { taskId: 't1' })])
    installStubBridge()
    render(<LinkTaskPicker issueId="i1" onClose={vi.fn()} />)
    const row = screen.getByRole('option', { name: /^Alpha/ })
    expect(row).toHaveTextContent('already linked')
    expect(row).toBeDisabled()
  })

  it.each(['none', 'provisioning', 'provision_failed'])(
    'disables a task with lifecycle "%s" as not-ready',
    (lifecycle) => {
      seed([task('t1', { name: 'Alpha', lifecycle })], [issue('i1')])
      installStubBridge()
      render(<LinkTaskPicker issueId="i1" onClose={vi.fn()} />)
      const row = screen.getByRole('option', { name: /^Alpha/ })
      expect(row).toHaveTextContent(`(${lifecycle})`)
      expect(row).toBeDisabled()
    }
  )

  it('clicking an enabled task binds it, with no confirmation prompt, and closes', async () => {
    seed([task('t1', { name: 'Alpha' })], [issue('i1')])
    installStubBridge()
    const onClose = vi.fn()
    render(<LinkTaskPicker issueId="i1" onClose={onClose} />)
    fireEvent.click(screen.getByRole('option', { name: /^Alpha/ }))
    expect(window.octopusAPI.issues.bind).toHaveBeenCalledWith({ issueId: 'i1', taskId: 't1' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('shows an error and stays open when the bind ack fails', async () => {
    seed([task('t1', { name: 'Alpha' })], [issue('i1')])
    installStubBridge({ ack: () => ({ ok: false, error: 'nope' }) })
    const onClose = vi.fn()
    render(<LinkTaskPicker issueId="i1" onClose={onClose} />)
    fireEvent.click(screen.getByRole('option', { name: /^Alpha/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('nope')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clicking Cancel closes without binding', () => {
    seed([task('t1', { name: 'Alpha' })], [issue('i1')])
    installStubBridge()
    const onClose = vi.fn()
    render(<LinkTaskPicker issueId="i1" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(window.octopusAPI.issues.bind).not.toHaveBeenCalled()
  })

  it('groups tasks by project like the task list: repos in task order, then No Repository, then Provisioning', () => {
    seed(
      [
        task('a1', { name: 'App one', position: 0, worktree: worktree('/src/app') }),
        task('l1', { name: 'Lib one', position: 1, worktree: worktree('/src/lib') }),
        task('n1', { name: 'Scratch', position: 2, repoLess: true }),
        task('p1', { name: 'Pending', position: 3, lifecycle: 'provisioning' }),
        task('a2', { name: 'App two', position: 4, worktree: worktree('/src/app') })
      ],
      [issue('i1')]
    )
    installStubBridge()
    render(<LinkTaskPicker issueId="i1" onClose={vi.fn()} />)

    const groups = within(screen.getByRole('listbox', { name: 'Tasks' })).getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'app',
      'lib',
      'No Repository',
      'Provisioning…'
    ])
    const names = (g: HTMLElement): string[] =>
      within(g)
        .getAllByRole('option')
        .map((o) => o.textContent ?? '')
    expect(names(groups[0])).toEqual(['App one', 'App two'])
    expect(names(groups[1])).toEqual(['Lib one'])
    expect(names(groups[2])).toEqual(['Scratch'])
    expect(names(groups[3])).toEqual([expect.stringContaining('Pending')])
    // Each group shows its project name as a visible header.
    expect(within(groups[0]).getByText('app')).toHaveAttribute('title', '/src/app')
  })

  it('clicking the backdrop closes the picker', () => {
    seed([task('t1', { name: 'Alpha' })], [issue('i1')])
    installStubBridge()
    const onClose = vi.fn()
    render(<LinkTaskPicker issueId="i1" onClose={onClose} />)
    fireEvent.click(screen.getByRole('presentation'))
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape closes the dialog', () => {
    seed([task('t1', { name: 'Alpha' })], [issue('i1')])
    installStubBridge()
    const onClose = vi.fn()
    render(<LinkTaskPicker issueId="i1" onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
