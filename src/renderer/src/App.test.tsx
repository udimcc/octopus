import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { installStubBridge } from './test-support/stub-bridge'
import { App } from './App'
import { useStore, initialData } from './store/store'
import type { IssueDTO, TaskDTO, WindowedWorkspaceStateDTO } from '../../shared/dto'

function state(
  activeTaskId: string | undefined,
  over: Partial<WindowedWorkspaceStateDTO> = {}
): WindowedWorkspaceStateDTO {
  return {
    tasks: [],
    activeTaskId,
    sessionTypes: [],
    issues: [],
    settings: {
      worktree: { location: '' },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      groupTasksByRepo: true
    },
    version: 1,
    thisWindowId: 'main',
    thisWindowRole: 'main',
    windows: [],
    ...over
  }
}

function issue(id: string, over: Partial<IssueDTO> = {}): IssueDTO {
  return {
    id,
    name: id,
    description: '',
    status: 'todo',
    blockedReasons: '',
    createdAt: 1000,
    updatedAt: 1000,
    source: 'local',
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

/**
 * The `IssuesDrawer` dialog, closed or open. `dom-accessibility-api`'s accessible-name
 * computation treats an `aria-hidden="true"` ROOT node as nameless regardless of the
 * query's own `hidden: true` option (that option only lifts the "is this accessible"
 * filter, not the name computation's own hidden check) — so `getByRole('dialog', {
 * name: 'Issues', hidden: true })` can never match it while closed. Filter by the
 * `aria-label` attribute directly instead.
 */
function issuesDrawer(): HTMLElement | null {
  return (
    screen
      .queryAllByRole('dialog', { hidden: true })
      .find((el) => el.getAttribute('aria-label') === 'Issues') ?? null
  )
}

describe('<App>', () => {
  beforeEach(() => {
    // Reset the store first: it's a module-level singleton, and App's mount-time
    // hydrate is async, so a leftover state from the previous test (issues, an open
    // drawer, …) could otherwise still be visible at the point a test asserts.
    useStore.setState(initialData())
    // Stub the preload bridge (no Electron in the test environment).
    installStubBridge({ state: state(undefined) })
  })

  it('renders the app title', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Octopus' })).toBeInTheDocument()
  })

  it('opens the New Task modal from the + New Task button', () => {
    render(<App />)
    expect(screen.queryByRole('dialog', { name: 'New Task' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ New Task' }))
    expect(screen.getByRole('dialog', { name: 'New Task' })).toBeInTheDocument()
  })

  it('triggers a mount-time switch to the hydrated active task (kicks off restore, §6.3)', async () => {
    installStubBridge({ state: state('task-1') })
    render(<App />)
    await waitFor(() =>
      expect(window.octopusAPI.tasks.switch).toHaveBeenCalledWith({ taskId: 'task-1' })
    )
    expect(window.octopusAPI.tasks.switch).toHaveBeenCalledTimes(1)
  })

  it('does not switch when there is no active task on launch', async () => {
    installStubBridge({ state: state(undefined) })
    render(<App />)
    // Let the getState promise settle before asserting the negative.
    await waitFor(() => expect(window.octopusAPI.app.getState).toHaveBeenCalled())
    expect(window.octopusAPI.tasks.switch).not.toHaveBeenCalled()
  })

  // ── Issues drawer (PRD "Issues" → "Issues window") ──────────────────────────

  it('mounts the Issues drawer only in the main window', async () => {
    installStubBridge({ state: state(undefined, { thisWindowRole: 'main' }) })
    const { unmount } = render(<App />)
    // Always mounted (even closed, behind aria-hidden) — waits because the
    // role-gated mount itself depends on the async mount-time hydrate landing.
    await waitFor(() => expect(issuesDrawer()).toBeInTheDocument())
    unmount()

    installStubBridge({ state: state(undefined, { thisWindowRole: 'secondary' }) })
    render(<App />)
    await waitFor(() => expect(issuesDrawer()).not.toBeInTheDocument())
  })

  it('an issuesDrawerToggle event toggles the drawer open in the main window', async () => {
    const bridge = installStubBridge({ state: state(undefined) })
    render(<App />)
    await waitFor(() => expect(window.octopusAPI.app.getState).toHaveBeenCalled())

    expect(issuesDrawer()).toHaveAttribute('aria-hidden', 'true')
    // The bridge's listeners run outside a DOM event, so React 18 won't flush the
    // resulting store update synchronously unless it's wrapped in `act`.
    act(() => bridge.emit({ type: 'issuesDrawerToggle' }))
    expect(issuesDrawer()).toHaveAttribute('aria-hidden', 'false')
  })

  it('inerts and aria-hides the workspace wrapper while the drawer is open', async () => {
    installStubBridge({ state: state(undefined) })
    render(<App />)
    await waitFor(() => expect(window.octopusAPI.app.getState).toHaveBeenCalled())

    // The workspace wrapper has no stable role/label of its own: locate it as the
    // parent of `TaskWorkspace`'s root `<section>`.
    const section = document.querySelector('section')
    if (!section) throw new Error('TaskWorkspace section not found')
    const wrapper = section.parentElement
    if (!wrapper) throw new Error('workspace wrapper not found')

    expect(wrapper).toHaveAttribute('aria-hidden', 'false')
    expect((wrapper as HTMLElement & { inert: boolean }).inert).toBe(false)

    act(() => useStore.getState().toggleIssuesDrawer())
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
    expect((wrapper as HTMLElement & { inert: boolean }).inert).toBe(true)

    act(() => useStore.getState().toggleIssuesDrawer())
    expect(wrapper).toHaveAttribute('aria-hidden', 'false')
    expect((wrapper as HTMLElement & { inert: boolean }).inert).toBe(false)
    // The real IssuesDrawer mounted here schedules its own close-time focus-restore
    // via a `setTimeout(0)` when it closed above. It IS cleaned up on reopen/unmount,
    // but neither happens by the end of this test — flush it here anyway, or its
    // callback can fire during a LATER test instead.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  describe('outside click closes the Issues drawer', () => {
    // A real click: mousedown (the drawer's outside-click listener) then click.
    function realClick(el: HTMLElement): void {
      fireEvent.mouseDown(el)
      fireEvent.click(el)
    }

    async function flushRestore(): Promise<void> {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
    }

    it('closes when a task row in the Progress panel is clicked, and the row still activates', async () => {
      installStubBridge({
        state: state('t1', { tasks: [task('t1', { name: 'Alpha' }), task('t2', { name: 'Beta' })] })
      })
      render(<App />)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument())
      act(() => useStore.getState().toggleIssuesDrawer())

      realClick(screen.getByRole('button', { name: 'Beta' }))
      expect(useStore.getState().issuesDrawerOpen).toBe(false)
      expect(window.octopusAPI.tasks.switch).toHaveBeenCalledWith({ taskId: 't2' })
      await flushRestore()
    })

    it('the Issues button still toggles it closed once (no close-then-reopen)', async () => {
      installStubBridge({ state: state(undefined) })
      render(<App />)
      await waitFor(() => expect(window.octopusAPI.app.getState).toHaveBeenCalled())
      const issuesButton = screen.getByRole('button', { name: 'Issues' })

      realClick(issuesButton)
      expect(useStore.getState().issuesDrawerOpen).toBe(true)
      realClick(issuesButton)
      expect(useStore.getState().issuesDrawerOpen).toBe(false)
      await flushRestore()
    })

    it("a task row's bound-issue icon navigates the open drawer instead of closing it", async () => {
      installStubBridge({
        state: state('t1', {
          tasks: [task('t1', { name: 'Alpha' })],
          issues: [issue('i1', { name: 'Fix bug', taskId: 't1' }), issue('i2')]
        })
      })
      render(<App />)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open issue Fix bug' })).toBeInTheDocument()
      )
      act(() => useStore.getState().openIssuesDrawer('i2'))
      // A close-then-reopen would end in the same state, so also prove the outside-click
      // close never ran.
      // `beforeEach` resets data only, so restore the real action afterwards.
      const original = useStore.getState().toggleIssuesDrawer
      const toggle = vi.fn()
      useStore.setState({ toggleIssuesDrawer: toggle })
      try {
        realClick(screen.getByRole('button', { name: 'Open issue Fix bug' }))
        expect(toggle).not.toHaveBeenCalled()
        expect(useStore.getState().issuesDrawerOpen).toBe(true)
        expect(useStore.getState().selectedIssueId).toBe('i1')
      } finally {
        useStore.setState({ toggleIssuesDrawer: original })
      }
    })
  })

  it('"Create task" from the Issues drawer opens New Task locked onto that issue', async () => {
    installStubBridge({ state: state(undefined, { issues: [issue('i1', { name: 'Fix bug' })] }) })
    render(<App />)
    await waitFor(() => expect(window.octopusAPI.app.getState).toHaveBeenCalled())

    // Open the drawer, select the issue, and use its "Create task" button —
    // exercising the real IssuesDrawer → IssueList → IssueDetail → App wiring
    // rather than calling the callback prop directly.
    fireEvent.click(screen.getByRole('button', { name: 'Issues' }))
    fireEvent.click(screen.getByRole('button', { name: /Fix bug/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    const modal = screen.getByRole('dialog', { name: 'New Task' })
    expect(modal).toBeInTheDocument()
    const picker = screen.getByLabelText('associated issue')
    expect(picker).toBeDisabled()
    await waitFor(() => expect(picker).toHaveAttribute('data-value', 'i1'))
    expect(screen.getByLabelText('task name')).toHaveValue('Fix bug')
  })

  it('"Delete both" on a bound issue opens DeleteTaskConfirm preset onto the connected task', async () => {
    installStubBridge({
      state: state('t1', {
        tasks: [task('t1', { name: 'Alpha' })],
        issues: [issue('i1', { name: 'Fix bug', taskId: 't1' })]
      })
    })
    render(<App />)
    await waitFor(() => expect(window.octopusAPI.app.getState).toHaveBeenCalled())

    // Exercise the real IssueDetail -> onDeleteBoundTask -> App wiring rather than
    // calling the callback prop directly.
    fireEvent.click(screen.getByRole('button', { name: 'Issues' }))
    const drawer = issuesDrawer()
    if (!drawer) throw new Error('issues drawer not found')
    fireEvent.click(within(drawer).getByRole('button', { name: /Fix bug/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete both' }))

    // `DeleteTaskConfirm` is mounted with a `preset`, so it dispatches on mount
    // with no further clicks needed, and skips its own choice step entirely.
    expect(
      screen.queryByRole('dialog', { name: 'Delete linked task and issue' })
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(window.octopusAPI.tasks.delete).toHaveBeenCalledWith({
        taskId: 't1',
        alsoDeleteIssue: true
      })
    )
  })
})
