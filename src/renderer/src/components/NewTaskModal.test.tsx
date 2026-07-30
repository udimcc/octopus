import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { OctopusAPI } from '../../../shared/ipc'
import type { EventDTO } from '../../../shared/events'
import { NewTaskModal } from './NewTaskModal'

/**
 * Stub the preload bridge with a controllable event stream so a test can drive
 * the create outcome (`activeTaskChanged` = success, `scriptError` = failure)
 * exactly as the backend would.
 */
function stubOctopusAPI(): { api: OctopusAPI; emit: (event: EventDTO) => void } {
  const listeners = new Set<(event: EventDTO) => void>()
  const ack = vi.fn().mockResolvedValue({ ok: true })
  const api: OctopusAPI = {
    ping: vi.fn().mockResolvedValue('pong'),
    tasks: { create: ack, delete: ack, rename: ack, reorder: ack, switch: ack },
    sessions: {
      create: ack,
      close: ack,
      rename: ack,
      reorder: ack,
      move: ack,
      cwd: vi.fn().mockResolvedValue(null),
      refreshState: vi.fn()
    },
    windows: {
      create: ack,
      close: ack,
      createWithSession: ack,
      windowAtPoint: vi.fn().mockResolvedValue(null)
    },
    pty: { write: vi.fn(), resize: vi.fn() },
    app: {
      getState: vi.fn(),
      updateSettings: ack,
      getWindowId: vi.fn(() => 'main'),
      getVersion: vi.fn().mockResolvedValue('0.0.0-test')
    },
    dialog: { pickDirectory: vi.fn().mockResolvedValue(undefined) },
    clipboard: {
      read: vi.fn().mockResolvedValue(''),
      write: vi.fn().mockResolvedValue(undefined)
    },
    onEvent: (handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    }
  }
  const emit = (event: EventDTO): void => {
    for (const l of listeners) l(event)
  }
  return { api, emit }
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('<NewTaskModal>', () => {
  let emit: (event: EventDTO) => void

  beforeEach(() => {
    const stub = stubOctopusAPI()
    window.octopusAPI = stub.api
    emit = stub.emit
  })

  it('prefills the new branch from the task name until edited', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    fill('task name', 'My Feature')
    expect(screen.getByLabelText('new branch')).toHaveValue('my-feature')

    // Editing the branch freezes it against further name changes.
    fill('new branch', 'custom/branch')
    fill('task name', 'Another Name')
    expect(screen.getByLabelText('new branch')).toHaveValue('custom/branch')
  })

  it('disables Create until all four fields are filled', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    const create = screen.getByRole('button', { name: 'Create Task' })
    expect(create).toBeDisabled()

    fill('task name', 'My Feature') // also prefills new branch
    fill('repo directory', '/repos/app')
    expect(create).toBeDisabled() // sourceBranch still empty
    fill('source branch', 'main')
    expect(create).toBeEnabled()
  })

  it('fills the repo directory from the native picker', async () => {
    window.octopusAPI.dialog.pickDirectory = vi.fn().mockResolvedValue('/picked/repo')
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(screen.getByLabelText('repo directory')).toHaveValue('/picked/repo'))
  })

  it('leaves the repo directory unchanged when the picker is cancelled', async () => {
    window.octopusAPI.dialog.pickDirectory = vi.fn().mockResolvedValue(undefined)
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(window.octopusAPI.dialog.pickDirectory).toHaveBeenCalled())
    expect(screen.getByLabelText('repo directory')).toHaveValue('')
  })

  it('dispatches create with the trimmed four-field payload (mode: new)', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    fill('task name', 'My Feature')
    fill('repo directory', '/repos/app')
    fill('source branch', ' main ')
    fill('new branch', ' feature/x ')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
      mode: 'new',
      name: 'My Feature',
      repoDir: '/repos/app',
      sourceBranch: 'main',
      newBranch: 'feature/x'
    })
  })

  it('defaults to the "From New Worktree" tab and hints master as the source branch', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    expect(screen.getByRole('tab', { name: 'From New Worktree' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByLabelText('source branch')).toHaveAttribute('placeholder', 'master')
  })

  it('reveals a per-tab info tooltip on hover, with distinct delete-behavior text', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    const info = screen.getByRole('button', { name: 'about task sources' })
    // No tooltip until hovered.
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // New-Worktree tab: removed on delete, and it explains HOW it's provisioned
    // (repo scripts vs. native git).
    fireEvent.mouseEnter(info)
    const newTip = screen.getByRole('tooltip')
    expect(newTip).toHaveTextContent(/removes it when the task is deleted/)
    expect(newTip).toHaveTextContent(/create_worktree\.sh/)
    expect(newTip).toHaveTextContent(/git worktree add/)
    fireEvent.mouseLeave(info)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // Existing-Repo tab: the directory is left on disk and nothing runs on delete.
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    fireEvent.mouseEnter(info)
    const existingTip = screen.getByRole('tooltip')
    expect(existingTip).toHaveTextContent(/leaves the directory on disk/)
    expect(existingTip).toHaveTextContent(/No delete script or git command runs/)
  })

  it('the Existing tab shows only task name + existing repo directory', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    expect(screen.getByLabelText('task name')).toBeInTheDocument()
    expect(screen.getByLabelText('existing repo directory')).toBeInTheDocument()
    // New-worktree-only fields are gone.
    expect(screen.queryByLabelText('repo directory')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('source branch')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('new branch')).not.toBeInTheDocument()
  })

  it('gates Create on name + repo dir in the Existing tab', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    const create = screen.getByRole('button', { name: 'Create Task' })
    expect(create).toBeDisabled()
    fill('task name', 'Adopted')
    expect(create).toBeDisabled() // repo dir still empty
    fill('existing repo directory', '/home/u/wt-x')
    expect(create).toBeEnabled()
  })

  it('dispatches create with the existing-repo payload (mode: existing)', () => {
    render(<NewTaskModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    fill('task name', ' Adopted ')
    fill('existing repo directory', '/home/u/wt-x')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    expect(window.octopusAPI.tasks.create).toHaveBeenCalledWith({
      mode: 'existing',
      name: 'Adopted',
      worktreeDir: '/home/u/wt-x'
    })
  })

  it('the Existing tab closes on success (activeTaskChanged)', async () => {
    const onClose = vi.fn()
    render(<NewTaskModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    fill('task name', 'Adopted')
    fill('existing repo directory', '/home/u/wt-x')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(window.octopusAPI.tasks.create).toHaveBeenCalled())

    emit({ type: 'activeTaskChanged', taskId: 'task-1' })
    expect(onClose).toHaveBeenCalled()
  })

  it('the Existing tab shows the adopt stderr inline on scriptError', async () => {
    const onClose = vi.fn()
    render(<NewTaskModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('tab', { name: 'From Existing Repo' }))
    fill('task name', 'Adopted')
    fill('existing repo directory', '/home/u/wt-x')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(window.octopusAPI.tasks.create).toHaveBeenCalled())

    emit({
      type: 'scriptError',
      taskId: 'task-1',
      script: 'adopt',
      exitCode: null,
      stderr: 'not a git worktree: /home/u/wt-x'
    })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not a git worktree'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('closes on success (activeTaskChanged for the created task)', async () => {
    const onClose = vi.fn()
    render(<NewTaskModal onClose={onClose} />)
    fill('task name', 'My Feature')
    fill('repo directory', '/repos/app')
    fill('source branch', 'main')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(window.octopusAPI.tasks.create).toHaveBeenCalled())

    emit({ type: 'activeTaskChanged', taskId: 'task-1' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the stderr inline and offers Retry on scriptError', async () => {
    const onClose = vi.fn()
    render(<NewTaskModal onClose={onClose} />)
    fill('task name', 'My Feature')
    fill('repo directory', '/repos/app')
    fill('source branch', 'main')
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
    render(<NewTaskModal onClose={vi.fn()} />)
    fill('task name', 'My Feature')
    fill('repo directory', '/repos/app')
    fill('source branch', 'main')
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(window.octopusAPI.tasks.create).toHaveBeenCalled())

    emit({ type: 'scriptProgress', taskId: 'task-1', line: 'Preparing worktree' })
    await waitFor(() => expect(screen.getByText('Preparing worktree')).toBeInTheDocument())
  })
})
