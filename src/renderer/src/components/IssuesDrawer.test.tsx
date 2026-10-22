import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { IssuesDrawer } from './IssuesDrawer'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { IssueDTO, SessionDTO, TaskDTO, WindowedWorkspaceStateDTO } from '../../../shared/dto'

vi.mock('../terminal/terminal-focus', () => ({ focusTerminal: vi.fn() }))
import { focusTerminal } from '../terminal/terminal-focus'

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
    windowId: 'main',
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

function seed(issues: IssueDTO[] = [], tasks: TaskDTO[] = [], activeTaskId?: string): void {
  const state: WindowedWorkspaceStateDTO = {
    tasks,
    activeTaskId,
    sessionTypes: [],
    issues,
    settings: {
      worktree: { location: '' },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      groupTasksByRepo: true,
      issuesKey: 'Alt+Shift+KeyI'
    },
    version: 1,
    thisWindowId: 'main',
    thisWindowRole: 'main',
    windows: []
  }
  useStore.getState().hydrate(state)
}

// A role query, but filtered by the `aria-label` ATTRIBUTE rather than the computed
// accessible NAME: the drawer stays mounted (and `aria-hidden`) while closed, and an
// `aria-hidden` root has no computed accessible name at all (confirmed empirically —
// `getByRole('dialog', { name: 'Issues', hidden: true })` never matches it in that
// state), so a role+name query can't be used here. `{ hidden: true }` alone still
// finds it by role regardless of `aria-hidden`/visibility; mirrors `issuesDrawer()`
// in App.test.tsx.
function drawerRoot(): HTMLElement {
  const el = screen
    .queryAllByRole('dialog', { hidden: true })
    .find((e) => e.getAttribute('aria-label') === 'Issues')
  if (!el) throw new Error('drawer root not found')
  return el
}

describe('<IssuesDrawer>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
    vi.mocked(focusTerminal).mockClear()
  })

  it('is aria-hidden and inert while closed, and neither once opened', () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    const root = drawerRoot()
    expect(root).toHaveAttribute('aria-hidden', 'true')
    expect((root as HTMLElement & { inert: boolean }).inert).toBe(true)

    act(() => useStore.getState().toggleIssuesDrawer())
    expect(root).toHaveAttribute('aria-hidden', 'false')
    expect((root as HTMLElement & { inert: boolean }).inert).toBe(false)
  })

  it('moves focus onto the drawer root when it opens (no other modal up)', () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().toggleIssuesDrawer())
    expect(document.activeElement).toBe(drawerRoot())
  })

  it('restores focus to the previously-focused element when it closes', async () => {
    seed()
    render(
      <>
        <button>outside</button>
        <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
      </>
    )
    const outside = screen.getByRole('button', { name: 'outside' })
    outside.focus()
    expect(document.activeElement).toBe(outside)

    act(() => useStore.getState().toggleIssuesDrawer()) // open
    expect(document.activeElement).toBe(drawerRoot())

    act(() => useStore.getState().toggleIssuesDrawer()) // close (clean)
    await waitFor(() => expect(document.activeElement).toBe(outside))
  })

  it('cancels a pending close-time focus-restore if the drawer reopens before it fires', async () => {
    seed()
    render(
      <>
        <button>outside</button>
        <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
      </>
    )
    const outside = screen.getByRole('button', { name: 'outside' })
    act(() => outside.focus())
    expect(document.activeElement).toBe(outside)

    act(() => useStore.getState().toggleIssuesDrawer()) // open
    act(() => useStore.getState().toggleIssuesDrawer()) // close: schedules restore-to-outside
    act(() => useStore.getState().toggleIssuesDrawer()) // reopen before that timer fires

    // Flush the macrotask the stale close-time timer would have fired on, had it
    // not been cleared by the reopen's effect cleanup.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(document.activeElement).toBe(drawerRoot())
    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('Escape closes the drawer when the edit is clean', async () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().toggleIssuesDrawer())
    expect(useStore.getState().issuesDrawerOpen).toBe(true)

    fireEvent.keyDown(drawerRoot(), { key: 'Escape' })
    expect(useStore.getState().issuesDrawerOpen).toBe(false)
    // The close effect schedules its focus-restore via a `setTimeout(0)` that IS
    // cleaned up (cleared on reopen/unmount) — but not by the end of this test, which
    // neither reopens nor unmounts. Flush it here anyway, or its callback fires during
    // a LATER test and touches that test's focus/DOM instead.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  it('Escape raises the discard prompt instead of closing when the edit is dirty', () => {
    seed([issue('i1')])
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => {
      useStore.getState().toggleIssuesDrawer()
      useStore.getState().selectIssue('i1')
      useStore.getState().setIssueEditDirty(true)
    })

    fireEvent.keyDown(drawerRoot(), { key: 'Escape' })
    expect(useStore.getState().issuesDrawerOpen).toBe(true)
    expect(useStore.getState().discardPrompt).toEqual({ kind: 'close' })
    expect(screen.getByRole('dialog', { name: 'Discard unsaved changes' })).toBeInTheDocument()
  })

  it('Escape is a no-op while another modal dialog is open', () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().toggleIssuesDrawer())

    const otherModal = document.createElement('div')
    otherModal.setAttribute('role', 'dialog')
    otherModal.setAttribute('aria-modal', 'true')
    document.body.appendChild(otherModal)
    try {
      fireEvent.keyDown(drawerRoot(), { key: 'Escape' })
      expect(useStore.getState().issuesDrawerOpen).toBe(true)
      expect(useStore.getState().discardPrompt).toBeNull()
    } finally {
      otherModal.remove()
    }
  })

  it('Escape closes a real nested dialog (Jira import) instead of the drawer, since the dialog owns focus and its own handler stops the event first', async () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().toggleIssuesDrawer())

    fireEvent.click(screen.getByRole('button', { name: 'Fetch from Jira' }))
    const modal = screen.getByRole('dialog', { name: 'Import from Jira' })
    // Settle the modal's own hasJiraKey() check before Escape, so its state update
    // can't land after it unmounts below.
    await waitFor(() => expect(screen.getByText('No Jira API key set.')).toBeInTheDocument())
    expect(document.activeElement).toBe(modal) // autofocused on open, per the overlay contract

    fireEvent.keyDown(modal, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Import from Jira' })).not.toBeInTheDocument()
    expect(useStore.getState().issuesDrawerOpen).toBe(true)
  })

  it('"Fetch from Jira" sits in the drawer header and opens the import modal on the Board tab too', async () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().toggleIssuesDrawer())
    fireEvent.click(screen.getByRole('tab', { name: 'Board' }))

    fireEvent.click(screen.getByRole('button', { name: 'Fetch from Jira' }))
    expect(screen.getByRole('dialog', { name: 'Import from Jira' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('No Jira API key set.')).toBeInTheDocument())
  })

  it('translates on/off screen via the transform style when toggled', () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    expect(drawerRoot()).toHaveStyle({ transform: 'translateX(100%)' })
    act(() => useStore.getState().toggleIssuesDrawer())
    expect(drawerRoot()).toHaveStyle({ transform: 'translateX(0)' })
  })

  it('Escape on the drawer root while discardPrompt is already up cancels it, like "Keep editing"', () => {
    seed([issue('i1')])
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => {
      useStore.getState().toggleIssuesDrawer()
      useStore.getState().selectIssue('i1')
      useStore.getState().setIssueEditDirty(true)
    })
    fireEvent.keyDown(drawerRoot(), { key: 'Escape' }) // raises discardPrompt
    expect(useStore.getState().discardPrompt).toEqual({ kind: 'close' })

    fireEvent.keyDown(drawerRoot(), { key: 'Escape' })
    expect(useStore.getState().discardPrompt).toBeNull()
    expect(useStore.getState().issueEditDirty).toBe(true) // kept editing, not discarded
    expect(useStore.getState().issuesDrawerOpen).toBe(true)
  })

  describe('the ✕ ("close issues") button', () => {
    it('is unreachable while the drawer is closed (inert)', () => {
      seed()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      // Unreachable via a normal accessible-tree query while closed — same effect the
      // aria-hidden/inert test above verifies on the root directly.
      expect(screen.queryByRole('button', { name: 'close issues' })).toBeNull()
      // It's still in the DOM, inside the root the other test confirms is `inert`.
      const closeButton = screen.getByRole('button', { name: 'close issues', hidden: true })
      expect(drawerRoot().contains(closeButton)).toBe(true)
      expect((drawerRoot() as HTMLElement & { inert: boolean }).inert).toBe(true)
    })

    it('closes the drawer, same as Escape, when the edit is clean', async () => {
      seed()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer())
      expect(useStore.getState().issuesDrawerOpen).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'close issues' }))
      expect(useStore.getState().issuesDrawerOpen).toBe(false)
      // Flush the close-time focus-restore timer (same cleanup note as the Escape test).
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
    })

    it('raises the discard prompt instead of closing when the edit is dirty, keeping the drawer open', () => {
      seed([issue('i1')])
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => {
        useStore.getState().toggleIssuesDrawer()
        useStore.getState().selectIssue('i1')
        useStore.getState().setIssueEditDirty(true)
      })

      fireEvent.click(screen.getByRole('button', { name: 'close issues' }))
      expect(useStore.getState().issuesDrawerOpen).toBe(true)
      expect(useStore.getState().discardPrompt).toEqual({ kind: 'close' })
      expect(screen.getByRole('dialog', { name: 'Discard unsaved changes' })).toBeInTheDocument()
    })

    it('restores focus to the previously-focused element when it closes the drawer, same as Escape', async () => {
      seed()
      render(
        <>
          <button>outside</button>
          <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
        </>
      )
      const outside = screen.getByRole('button', { name: 'outside' })
      outside.focus()

      act(() => useStore.getState().toggleIssuesDrawer()) // open
      expect(document.activeElement).toBe(drawerRoot())

      fireEvent.click(screen.getByRole('button', { name: 'close issues' }))
      await waitFor(() => expect(document.activeElement).toBe(outside))
    })
  })

  describe('focus contract while open: focusout to <body>', () => {
    it('moves focus back onto the drawer root when no modal is up', async () => {
      seed()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer())
      expect(document.activeElement).toBe(drawerRoot())

      act(() => drawerRoot().blur())
      expect(document.activeElement).toBe(document.body)
      await waitFor(() => expect(document.activeElement).toBe(drawerRoot()))
    })

    it('moves focus to the topmost modal when one is open', async () => {
      seed()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer())

      const modal = document.createElement('div')
      modal.setAttribute('aria-modal', 'true')
      modal.tabIndex = -1
      document.body.appendChild(modal)
      try {
        act(() => drawerRoot().blur())
        expect(document.activeElement).toBe(document.body)
        await waitFor(() => expect(document.activeElement).toBe(modal))
      } finally {
        modal.remove()
      }
    })

    it('closing immediately after a focusout cancels the pending re-focus-root timer, so the close wins', async () => {
      seed()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer()) // open
      expect(document.activeElement).toBe(drawerRoot())

      act(() => drawerRoot().blur()) // schedules a timer to refocus the (still-open) root
      act(() => useStore.getState().toggleIssuesDrawer()) // close immediately, before that timer fires

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(document.activeElement).not.toBe(drawerRoot())
    })
  })

  describe('close-time focus fallback chain', () => {
    it('falls back to the active terminal when the saved target is <body> (nothing was really focused)', async () => {
      seed(
        [],
        [task('t1', { sessions: [session('s1', { taskId: 't1', windowId: 'main' })] })],
        't1'
      )
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer()) // open: nothing was focused -> saved = body
      act(() => useStore.getState().toggleIssuesDrawer()) // close
      // jsdom doesn't move focus off a newly-inert element; Chromium does (to <body>).
      act(() => drawerRoot().blur())
      expect(document.activeElement).toBe(document.body)
      await waitFor(() => expect(focusTerminal).toHaveBeenCalledWith('s1'))
    })

    it('falls back to the #issues-drawer-toggle button when there is no active terminal either', async () => {
      seed()
      render(
        <>
          <button id="issues-drawer-toggle">Issues</button>
          <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
        </>
      )
      act(() => useStore.getState().toggleIssuesDrawer()) // open: saved = body
      act(() => useStore.getState().toggleIssuesDrawer()) // close
      await waitFor(() =>
        expect(document.activeElement).toBe(document.getElementById('issues-drawer-toggle'))
      )
      expect(focusTerminal).not.toHaveBeenCalled()
    })

    it('falls through to the terminal/button fallback when the saved element can no longer take focus (now inert)', async () => {
      seed(
        [],
        [task('t1', { sessions: [session('s1', { taskId: 't1', windowId: 'main' })] })],
        't1'
      )
      render(
        <>
          <div id="wrap">
            <button>outside</button>
          </div>
          <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
        </>
      )
      const outside = screen.getByRole('button', { name: 'outside' })
      outside.focus()
      expect(document.activeElement).toBe(outside)

      act(() => useStore.getState().toggleIssuesDrawer()) // open: saved = outside
      // Simulate the saved element becoming unreachable while the drawer was open
      // (e.g. an ancestor went `inert`). The production check is a plain
      // `[inert]` attribute-selector lookup done BEFORE calling `.focus()`, so set
      // the DOM attribute directly rather than relying on jsdom to enforce it.
      document.getElementById('wrap')!.setAttribute('inert', '')
      act(() => useStore.getState().toggleIssuesDrawer()) // close
      await waitFor(() => expect(focusTerminal).toHaveBeenCalledWith('s1'))
      expect(document.activeElement).not.toBe(outside)
      document.getElementById('wrap')!.removeAttribute('inert')
    })

    it('falls through to the terminal/button fallback when the saved element is connected and not inert, but its own .focus() silently no-ops', async () => {
      seed(
        [],
        [task('t1', { sessions: [session('s1', { taskId: 't1', windowId: 'main' })] })],
        't1'
      )
      render(
        <>
          <button>outside</button>
          <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
        </>
      )
      const outside = screen.getByRole('button', { name: 'outside' })
      outside.focus()
      expect(document.activeElement).toBe(outside)
      // Connected, not inert — but calling .focus() on it doesn't actually move
      // focus (e.g. it became `visibility: hidden` or `display: none` underneath
      // another now-active element).
      vi.spyOn(outside, 'focus').mockImplementation(() => {})

      act(() => useStore.getState().toggleIssuesDrawer()) // open: saved = outside
      act(() => useStore.getState().toggleIssuesDrawer()) // close
      await waitFor(() => expect(focusTerminal).toHaveBeenCalledWith('s1'))
    })

    it('falls back to the NOW-active terminal when the active session changed while the drawer was open and the saved element silently no-ops', async () => {
      seed(
        [],
        [
          task('t1', {
            sessions: [
              session('s1', { taskId: 't1', windowId: 'main' }),
              session('s2', { taskId: 't1', windowId: 'main' })
            ]
          })
        ],
        't1'
      )
      render(
        <>
          <button>outside</button>
          <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
        </>
      )
      const outside = screen.getByRole('button', { name: 'outside' })
      outside.focus()
      vi.spyOn(outside, 'focus').mockImplementation(() => {})

      act(() => useStore.getState().toggleIssuesDrawer()) // open: saved = outside
      act(() => useStore.getState().setActiveSession('t1', 's2')) // switch while open
      act(() => useStore.getState().toggleIssuesDrawer()) // close
      await waitFor(() => expect(focusTerminal).toHaveBeenCalledWith('s2'))
      expect(focusTerminal).not.toHaveBeenCalledWith('s1')
    })

    it('does not call focusTerminal if the component unmounts right after closing, before the close-time timer fires', async () => {
      seed(
        [],
        [task('t1', { sessions: [session('s1', { taskId: 't1', windowId: 'main' })] })],
        't1'
      )
      const { unmount } = render(
        <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
      )
      act(() => useStore.getState().toggleIssuesDrawer()) // open: nothing focused -> saved = body
      act(() => useStore.getState().toggleIssuesDrawer()) // close: schedules the close-time timer
      unmount() // before that timer fires
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(focusTerminal).not.toHaveBeenCalled()
    })

    it('restores a saved element that is still focusable, without touching the terminal/button fallback', async () => {
      seed(
        [],
        [task('t1', { sessions: [session('s1', { taskId: 't1', windowId: 'main' })] })],
        't1'
      )
      render(
        <>
          <button>outside</button>
          <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
        </>
      )
      const outside = screen.getByRole('button', { name: 'outside' })
      outside.focus()

      act(() => useStore.getState().toggleIssuesDrawer()) // open
      act(() => useStore.getState().toggleIssuesDrawer()) // close (clean)
      await waitFor(() => expect(document.activeElement).toBe(outside))
      expect(focusTerminal).not.toHaveBeenCalled()
    })
  })

  describe('close-time focus vs. an App-level modal', () => {
    it('a modal already focused when the drawer closes keeps its focus (no steal)', async () => {
      seed(
        [],
        [task('t1', { sessions: [session('s1', { taskId: 't1', windowId: 'main' })] })],
        't1'
      )
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer()) // open, no modal yet -> root focused

      const modal = document.createElement('div')
      modal.setAttribute('aria-modal', 'true')
      modal.tabIndex = -1
      document.body.appendChild(modal)
      modal.focus()
      expect(document.activeElement).toBe(modal)

      try {
        act(() => useStore.getState().toggleIssuesDrawer()) // close, modal still up
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0))
        })
        expect(document.activeElement).toBe(modal)
        expect(focusTerminal).not.toHaveBeenCalled()
      } finally {
        modal.remove()
      }
    })

    it('does not steal focus from something other than <body> that already has it, even with a modal open', async () => {
      seed()
      render(
        <>
          <button>other</button>
          <IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />
        </>
      )
      act(() => useStore.getState().toggleIssuesDrawer()) // open: saved = body

      const modal = document.createElement('div')
      modal.setAttribute('aria-modal', 'true')
      modal.tabIndex = -1
      document.body.appendChild(modal)
      const other = screen.getByRole('button', { name: 'other' })
      try {
        act(() => {
          other.focus()
          useStore.getState().toggleIssuesDrawer() // close, modal still up
        })
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0))
        })
        expect(document.activeElement).toBe(other)
      } finally {
        modal.remove()
      }
    })

    it('a modal present when the drawer closes receives focus if focus had dropped to <body>', async () => {
      seed()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer()) // open: root focused

      const modal = document.createElement('div')
      modal.setAttribute('aria-modal', 'true')
      modal.tabIndex = -1
      document.body.appendChild(modal)
      act(() => drawerRoot().blur()) // focus drops to <body>
      try {
        act(() => useStore.getState().toggleIssuesDrawer()) // close
        await waitFor(() => expect(document.activeElement).toBe(modal))
      } finally {
        modal.remove()
      }
    })

    it('opening while a modal is already up does not steal focus onto the drawer root', () => {
      seed()
      const modal = document.createElement('div')
      modal.setAttribute('aria-modal', 'true')
      modal.tabIndex = -1
      document.body.appendChild(modal)
      modal.focus()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      try {
        act(() => useStore.getState().toggleIssuesDrawer()) // open
        expect(document.activeElement).toBe(modal)
        expect(document.activeElement).not.toBe(drawerRoot())
      } finally {
        modal.remove()
      }
    })

    it('closing later, after that modal is gone, still runs the normal close-time fallback', async () => {
      seed(
        [],
        [task('t1', { sessions: [session('s1', { taskId: 't1', windowId: 'main' })] })],
        't1'
      )
      const modal = document.createElement('div')
      modal.setAttribute('aria-modal', 'true')
      modal.tabIndex = -1
      document.body.appendChild(modal)
      modal.focus()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer()) // open while the modal is up: saved = modal
      modal.remove() // the modal goes away before the drawer closes
      act(() => useStore.getState().toggleIssuesDrawer()) // close
      await waitFor(() => expect(focusTerminal).toHaveBeenCalledWith('s1'))
    })
  })

  it('also stops a non-issuesKey chord typed into the description textarea from bubbling', () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().startNewIssue())
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByLabelText('issue description'), {
        code: 'ArrowDown',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('also stops a non-issuesKey chord typed into the project select from bubbling', () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().startNewIssue())
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByLabelText('issue project'), {
        code: 'ArrowDown',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('stops a non-issuesKey chord typed into an editable field from bubbling to the window', () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().startNewIssue())
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByLabelText('issue name'), {
        code: 'ArrowDown',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('lets the configured issuesKey chord bubble even from an editable field', () => {
    seed()
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().startNewIssue())
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByLabelText('issue name'), {
        code: 'KeyI',
        altKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('matches a REBOUND issuesKey from settings, not the hardcoded Alt+Shift+KeyI default', () => {
    seed()
    useStore.setState((s) => ({ settings: { ...s.settings, issuesKey: 'Ctrl+Shift+KeyJ' } }))
    render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
    act(() => useStore.getState().startNewIssue())
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      // The newly-configured chord passes through from the editable field.
      fireEvent.keyDown(screen.getByLabelText('issue name'), {
        code: 'KeyJ',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).toHaveBeenCalledTimes(1)

      // The default chord is no longer configured, so it's stopped like any other
      // non-issuesKey chord typed into an editable field.
      fireEvent.keyDown(screen.getByLabelText('issue name'), {
        code: 'KeyI',
        altKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })

  it('forwards onCreateTaskFromIssue/onDeleteBoundTask through to IssueDetail', () => {
    seed([issue('i1')])
    const onCreateTaskFromIssue = vi.fn()
    render(
      <IssuesDrawer onCreateTaskFromIssue={onCreateTaskFromIssue} onDeleteBoundTask={vi.fn()} />
    )
    act(() => {
      useStore.getState().toggleIssuesDrawer()
      useStore.getState().selectIssue('i1')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect(onCreateTaskFromIssue).toHaveBeenCalledWith('i1')
  })

  describe('Board tab (header tabs, + New Issue, selection follow)', () => {
    it('List is selected by default; clicking the Board tab switches the tabpanel and the store tab', () => {
      seed()
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer())
      expect(screen.getByRole('tab', { name: 'List' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByRole('tabpanel', { name: 'List' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('tab', { name: 'Board' }))
      expect(useStore.getState().issuesDrawerTab).toBe('board')
      expect(screen.getByRole('tabpanel', { name: 'Board' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true')
    })

    it('switching tabs keeps the selection and a dirty edit, with no discard prompt', () => {
      seed([issue('i1')])
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => {
        useStore.getState().toggleIssuesDrawer()
        useStore.getState().selectIssue('i1')
        useStore.getState().setIssueEditDirty(true)
      })

      fireEvent.click(screen.getByRole('tab', { name: 'Board' }))
      expect(useStore.getState().selectedIssueId).toBe('i1')
      expect(useStore.getState().issueEditDirty).toBe(true)
      expect(useStore.getState().discardPrompt).toBeNull()

      fireEvent.click(screen.getByRole('tab', { name: 'List' }))
      expect(useStore.getState().selectedIssueId).toBe('i1')
      expect(useStore.getState().issueEditDirty).toBe(true)
      expect(useStore.getState().discardPrompt).toBeNull()
    })

    it('+ New Issue starts a draft from the List tab', () => {
      seed([])
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer())
      fireEvent.click(screen.getByRole('button', { name: '+ New Issue' }))
      expect(useStore.getState().issueDraft).toBe(true)
    })

    it('+ New Issue starts a draft from the Board tab', () => {
      seed([])
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => {
        useStore.getState().toggleIssuesDrawer()
        useStore.getState().setIssuesDrawerTab('board')
      })
      fireEvent.click(screen.getByRole('button', { name: '+ New Issue' }))
      expect(useStore.getState().issueDraft).toBe(true)
    })

    it('the "+ New Issue" button is a compact header button, not a full-width bar', () => {
      seed([])
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer())
      expect(screen.getByRole('button', { name: '+ New Issue' }).style.width).toBe('')
    })

    it('the placeholder shows with no selection, on both tabs', () => {
      seed([])
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().toggleIssuesDrawer())
      expect(screen.getByText('Select an issue, or create a new one.')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('tab', { name: 'Board' }))
      expect(screen.getByText('Select an issue, or create a new one.')).toBeInTheDocument()
    })

    it('the issue view keeps the same width style on both tabs', () => {
      seed([issue('i1')])
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => {
        useStore.getState().toggleIssuesDrawer()
        useStore.getState().selectIssue('i1')
      })
      const wrapperOnList = document.querySelector<HTMLElement>('div[style*="360px"]')
      expect(wrapperOnList).not.toBeNull()
      expect(wrapperOnList).toHaveStyle({ flex: '0 0 61%', minWidth: '360px' })

      fireEvent.click(screen.getByRole('tab', { name: 'Board' }))
      const wrapperOnBoard = document.querySelector<HTMLElement>('div[style*="360px"]')
      expect(wrapperOnBoard).not.toBeNull()
      expect(wrapperOnBoard).toHaveStyle({ flex: '0 0 61%', minWidth: '360px' })
    })

    it('openIssuesDrawer(id) opens on the last-used tab', () => {
      seed([issue('i1')])
      render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
      act(() => useStore.getState().setIssuesDrawerTab('board')) // last-used, while closed
      act(() => useStore.getState().openIssuesDrawer('i1'))
      expect(useStore.getState().issuesDrawerOpen).toBe(true)
      expect(screen.getByRole('tabpanel', { name: 'Board' })).toBeInTheDocument()
    })

    it('on List, a collapsed Done group holding the selected issue auto-expands and scrolls it into view', () => {
      seed([issue('d1', { status: 'done', name: 'Finished thing' })])
      const scrollSpy = vi.fn()
      // jsdom doesn't implement scrollIntoView at all (no property to spy on).
      ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy
      try {
        render(<IssuesDrawer onCreateTaskFromIssue={vi.fn()} onDeleteBoundTask={vi.fn()} />)
        act(() => useStore.getState().openIssuesDrawer('d1'))
        const doneHeader = screen.getByText(/^[▾▸] Done$/).closest('button')
        expect(doneHeader).toHaveAttribute('aria-expanded', 'true')
        expect(scrollSpy).toHaveBeenCalled()
      } finally {
        delete (Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView
      }
    })
  })
})
