import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ProjectSidebar, type ProjectSidebarProps } from './ProjectSidebar'
import type { ProjectListItemDTO } from '../../../shared/dto'

function project(path: string, over: Partial<ProjectListItemDTO> = {}): ProjectListItemDTO {
  return { path, defaultBranch: 'main', taskCount: 0, ...over }
}

const noop = (): void => {}

function renderSidebar(over: Partial<ProjectSidebarProps> = {}): void {
  render(
    <ProjectSidebar
      projects={over.projects ?? [project('/repos/app')]}
      selectedPath={over.selectedPath}
      busy={over.busy ?? false}
      loading={over.loading}
      error={over.error}
      onSelect={over.onSelect ?? noop}
      onAdd={over.onAdd ?? noop}
      onRemove={over.onRemove ?? noop}
      onSetDefaultBranch={over.onSetDefaultBranch ?? noop}
    />
  )
}

describe('<ProjectSidebar>', () => {
  it('shows the repo basename as the label and the full path as the title', () => {
    renderSidebar({ projects: [project('/home/u/repos/Trading/')] })
    const row = screen.getByRole('option', { name: 'Trading' })
    expect(row).toHaveAttribute('title', '/home/u/repos/Trading/')
  })

  it('disables delete with an "In use by N task(s)" tooltip when taskCount > 0', () => {
    renderSidebar({ projects: [project('/repos/app', { taskCount: 1 })] })
    const del = screen.getByRole('button', { name: 'remove project app' })
    expect(del).toBeDisabled()
    expect(del).toHaveAttribute('title', 'In use by 1 task')
  })

  it('pluralizes the tooltip for more than one task', () => {
    renderSidebar({ projects: [project('/repos/app', { taskCount: 3 })] })
    const del = screen.getByRole('button', { name: 'remove project app' })
    expect(del).toBeDisabled()
    expect(del).toHaveAttribute('title', 'In use by 3 tasks')
  })

  it('enables delete with no tooltip when the project has no tasks', () => {
    renderSidebar({ projects: [project('/repos/app', { taskCount: 0 })] })
    const del = screen.getByRole('button', { name: 'remove project app' })
    expect(del).toBeEnabled()
    expect(del).not.toHaveAttribute('title')
  })

  it('opens an in-row confirm on delete, and ✓ confirms it', () => {
    const onRemove = vi.fn()
    renderSidebar({ onRemove })
    fireEvent.click(screen.getByRole('button', { name: 'remove project app' }))
    expect(screen.getByText('Remove?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'confirm remove project app' }))
    expect(onRemove).toHaveBeenCalledWith('/repos/app')
  })

  it('✗ cancels the confirm without calling onRemove', () => {
    const onRemove = vi.fn()
    renderSidebar({ onRemove })
    fireEvent.click(screen.getByRole('button', { name: 'remove project app' }))
    fireEvent.click(screen.getByRole('button', { name: 'cancel remove project app' }))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.queryByText('Remove?')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'remove project app' })).toBeInTheDocument()
  })

  it('focuses ✗ as soon as the confirm opens', () => {
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'remove project app' }))
    expect(screen.getByRole('button', { name: 'cancel remove project app' })).toHaveFocus()
  })

  it('Escape inside the confirm cancels it, returns focus to the row, and does not bubble', () => {
    const outerKeyDown = vi.fn()
    render(
      <div onKeyDown={outerKeyDown}>
        <ProjectSidebar
          projects={[project('/repos/app')]}
          busy={false}
          onSelect={noop}
          onAdd={noop}
          onRemove={noop}
          onSetDefaultBranch={noop}
        />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'remove project app' }))
    const cancelButton = screen.getByRole('button', { name: 'cancel remove project app' })
    fireEvent.keyDown(cancelButton, { key: 'Escape' })

    expect(outerKeyDown).not.toHaveBeenCalled()
    expect(screen.queryByText('Remove?')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'app' })).toHaveFocus()
  })

  it('selects on row Enter/Space, but a keydown bubbling from a nested control or input does not select', () => {
    const onSelect = vi.fn()
    renderSidebar({ onSelect })
    const row = screen.getByRole('option', { name: 'app' })
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    expect(onSelect).toHaveBeenCalledTimes(2)

    onSelect.mockClear()
    fireEvent.keyDown(screen.getByRole('button', { name: 'remove project app' }), { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.doubleClick(screen.getByText('main'))
    const input = screen.getByLabelText('edit default branch for app')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('disables every control when busy', () => {
    const onSelect = vi.fn()
    renderSidebar({ busy: true, onSelect })
    expect(screen.getByRole('button', { name: 'remove project app' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '+ Add project' })).toBeDisabled()
    fireEvent.click(screen.getByRole('option', { name: 'app' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows "No projects yet" when empty and not loading', () => {
    renderSidebar({ projects: [], loading: false })
    expect(screen.getByText('No projects yet')).toBeInTheDocument()
  })

  it('shows "Loading…" while the initial fetch is in flight', () => {
    renderSidebar({ projects: [], loading: true })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows the error as role="alert"', () => {
    renderSidebar({ error: 'boom' })
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })

  it('calls onSetDefaultBranch from an inline default-branch edit', () => {
    const onSetDefaultBranch = vi.fn()
    renderSidebar({ onSetDefaultBranch })
    fireEvent.doubleClick(screen.getByText('main'))
    const input = screen.getByLabelText('edit default branch for app')
    fireEvent.change(input, { target: { value: 'develop' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSetDefaultBranch).toHaveBeenCalledWith('/repos/app', 'develop')
  })

  // ── Focus restore ────────────────────────────────────────────────────────────
  //
  // The real IPC round trip is asynchronous; this harness lets a test control
  // exactly when the in-flight action settles (flipping `busy` back to false),
  // so it can inspect focus mid-flight and right after settlement.

  interface Control {
    finish: () => void
  }

  function Harness(props: {
    projects: ProjectListItemDTO[]
    onRemove?: (path: string) => void
    onAdd?: () => void
    onSetDefaultBranch?: (path: string, branch: string) => void
    controlRef: { current: Control | null }
  }): React.JSX.Element {
    const [busy, setBusy] = useState(false)
    const [list, setList] = useState(props.projects)

    const start = (after: () => void): void => {
      setBusy(true)
      props.controlRef.current = {
        finish: () => {
          after()
          setBusy(false)
        }
      }
    }

    return (
      <ProjectSidebar
        projects={list}
        busy={busy}
        onSelect={noop}
        onAdd={() => start(() => props.onAdd?.())}
        onRemove={(path) =>
          start(() => {
            setList((l) => l.filter((p) => p.path !== path))
            props.onRemove?.(path)
          })
        }
        onSetDefaultBranch={(path, branch) => start(() => props.onSetDefaultBranch?.(path, branch))}
      />
    )
  }

  it('restores focus to "+ Add project" after a successful remove, and the row disappears', () => {
    const controlRef: { current: Control | null } = { current: null }
    render(<Harness projects={[project('/repos/app')]} controlRef={controlRef} />)

    fireEvent.click(screen.getByRole('button', { name: 'remove project app' }))
    fireEvent.click(screen.getByRole('button', { name: 'confirm remove project app' }))
    // The action is in flight (busy); the row and its ✓ button are gone from
    // the confirm, and Add is disabled.
    expect(screen.getByRole('button', { name: '+ Add project' })).toBeDisabled()

    act(() => controlRef.current?.finish())

    expect(screen.queryByRole('option', { name: 'app' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add project' })).toHaveFocus()
  })

  it('restores focus to "+ Add project" after add', () => {
    const controlRef: { current: Control | null } = { current: null }
    render(<Harness projects={[project('/repos/app')]} controlRef={controlRef} />)

    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }))
    expect(screen.getByRole('button', { name: '+ Add project' })).toBeDisabled()

    act(() => controlRef.current?.finish())

    expect(screen.getByRole('button', { name: '+ Add project' })).toHaveFocus()
  })

  it('restores focus to the row after a default-branch commit', () => {
    const controlRef: { current: Control | null } = { current: null }
    render(<Harness projects={[project('/repos/app')]} controlRef={controlRef} />)

    fireEvent.doubleClick(screen.getByText('main'))
    const input = screen.getByLabelText('edit default branch for app')
    fireEvent.change(input, { target: { value: 'develop' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    act(() => controlRef.current?.finish())

    expect(screen.getByRole('option', { name: 'app' })).toHaveFocus()
  })

  it('does not steal focus that the user already moved elsewhere while busy', () => {
    const controlRef: { current: Control | null } = { current: null }
    render(
      <div>
        <button type="button">outside</button>
        <Harness projects={[project('/repos/app')]} controlRef={controlRef} />
      </div>
    )

    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }))
    expect(screen.getByRole('button', { name: '+ Add project' })).toBeDisabled()

    // The user focused something else while the action was in flight.
    screen.getByRole('button', { name: 'outside' }).focus()
    expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus()

    act(() => controlRef.current?.finish())

    // Focus was NOT lost to <body>, so it must not be stolen back.
    expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus()
  })
})
