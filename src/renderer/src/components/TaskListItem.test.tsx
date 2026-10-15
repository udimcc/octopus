import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, createEvent, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { TaskListItem } from './TaskListItem'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { IssueDTO, TaskDTO, WindowDTO } from '../../../shared/dto'
import type { TaskEntry } from '../store/store'

function entry(id: string, over: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id,
    name: id,
    lifecycle: 'ready',
    state: 'unknown',
    sessionIds: [],
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

/** Seed the store's issue projection without going through full task hydration. */
function seedIssues(issues: IssueDTO[]): void {
  useStore.getState().hydrate({
    tasks: [task('t1')],
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
  })
}

/** Seed the store's task + window set, from the perspective of `thisWindowId`
 * (window-view feature). */
function seedWindows(thisWindowId: string, windows: WindowDTO[]): void {
  useStore.getState().hydrate({
    tasks: [task('t1')],
    activeTaskId: undefined,
    sessionTypes: [],
    issues: [],
    settings: {
      worktree: { location: '' },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      groupTasksByRepo: true
    },
    version: 1,
    thisWindowId,
    thisWindowRole: thisWindowId === 'main' ? 'main' : 'secondary',
    windows
  })
}

function windowDTO(id: string, over: Partial<WindowDTO> = {}): WindowDTO {
  return {
    id,
    role: 'secondary',
    bounds: { x: 0, y: 0, width: 900, height: 640 },
    createdAt: 0,
    ...over
  }
}

/** `TaskListItem` is a dnd-kit sortable handle, so it needs a `DndContext` +
 * `SortableContext` ancestor to render without throwing. */
function renderRow(
  task1: TaskEntry,
  overrides: Partial<Parameters<typeof TaskListItem>[0]> = {}
): ReturnType<typeof render> {
  const onActivate = overrides.onActivate ?? vi.fn()
  const onRename = overrides.onRename ?? vi.fn()
  return render(
    <DndContext>
      <SortableContext items={[task1.id]}>
        <ul>
          <TaskListItem
            task={task1}
            active={overrides.active ?? false}
            onActivate={onActivate}
            onRename={onRename}
            display={overrides.display ?? 'idle'}
            indent={overrides.indent}
            readOnly={overrides.readOnly}
            onCreateView={overrides.onCreateView}
          />
        </ul>
      </SortableContext>
    </DndContext>
  )
}

describe('<TaskListItem>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('shows no issue icon when the task has no bound issue', () => {
    seedIssues([])
    renderRow(entry('t1', { name: 'Alpha' }))
    // The row's OWN status icon is still role="img" — only the "Open issue …"
    // button (and its nested issue-status glyph) must be absent.
    expect(screen.queryByRole('button', { name: /Open issue/ })).not.toBeInTheDocument()
  })

  it('shows the bound issue status icon with the issue name as the title', () => {
    seedIssues([issue('i1', { name: 'Fix the thing', status: 'in_review', taskId: 't1' })])
    renderRow(entry('t1', { name: 'Alpha' }))

    const openButton = screen.getByRole('button', { name: 'Open issue Fix the thing' })
    expect(openButton).toHaveAttribute('title', 'Fix the thing')

    const icon = within(openButton).getByRole('img')
    // The title override shows the ISSUE NAME, not the status label ("In review").
    expect(icon).toHaveAttribute('aria-label', 'Fix the thing')
    expect(icon).toHaveAttribute('title', 'Fix the thing')
  })

  it('clicking the issue icon opens the drawer on that issue without activating the task', () => {
    seedIssues([issue('i1', { name: 'Fix the thing', status: 'todo', taskId: 't1' })])
    const onActivate = vi.fn()
    renderRow(entry('t1', { name: 'Alpha' }), { onActivate })

    fireEvent.click(screen.getByRole('button', { name: 'Open issue Fix the thing' }))

    expect(useStore.getState().issuesDrawerOpen).toBe(true)
    expect(useStore.getState().selectedIssueId).toBe('i1')
    // stopPropagation on the nested button's onClick must keep the row's own
    // onClick (which calls onActivate) from also firing.
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('stops pointerdown propagation on the issue icon so dnd-kit never sees it', () => {
    seedIssues([issue('i1', { name: 'Fix the thing', status: 'todo', taskId: 't1' })])
    renderRow(entry('t1', { name: 'Alpha' }))

    const openButton = screen.getByRole('button', { name: 'Open issue Fix the thing' })
    // React 17+ delegates events to the root container and simulates bubbling
    // internally, so a plain `addEventListener` on an intermediate DOM ancestor
    // (e.g. the row) would fire before React's own `stopPropagation()` call ever
    // runs — it can't observe this. Spying directly on the native event's
    // `stopPropagation` method does.
    const event = createEvent.pointerDown(openButton)
    const stopPropagation = vi.spyOn(event, 'stopPropagation')
    fireEvent(openButton, event)

    expect(stopPropagation).toHaveBeenCalled()
  })
})

describe('<TaskListItem> window-view feature (context menu, readOnly, viewed-elsewhere)', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  describe('context menu (right-click)', () => {
    it('opens on right-click in a normal (non-readOnly) row with onCreateView, offering "+ New Window From Task"', () => {
      seedWindows('main', [])
      const onCreateView = vi.fn()
      renderRow(entry('t1', { name: 'Alpha' }), { onCreateView })

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }))

      const menu = screen.getByRole('menu', { name: 'task actions' })
      const item = within(menu).getByRole('menuitem', { name: '+ New Window From Task' })
      expect(item).toBeEnabled()
    })

    it('does nothing on right-click when readOnly, even with onCreateView supplied', () => {
      seedWindows('view-1', [windowDTO('view-1', { role: 'view', taskId: 't1' })])
      const onCreateView = vi.fn()
      renderRow(entry('t1', { name: 'Alpha' }), { readOnly: true, onCreateView })

      fireEvent.contextMenu(screen.getByText('Alpha'))

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('does nothing on right-click when onCreateView is omitted (view window offers no menu)', () => {
      seedWindows('main', [])
      renderRow(entry('t1', { name: 'Alpha' }))

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }))

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('disables "+ New Window From Task" when the task already has a view (isViewedTask)', () => {
      seedWindows('main', [windowDTO('view-1', { role: 'view', taskId: 't1' })])
      renderRow(entry('t1', { name: 'Alpha' }), { onCreateView: vi.fn() })

      fireEvent.contextMenu(screen.getByRole('button', { name: /Alpha/ }))

      const menu = screen.getByRole('menu', { name: 'task actions' })
      const item = within(menu).getByRole('menuitem', { name: '+ New Window From Task' })
      expect(item).toBeDisabled()
      expect(item).toHaveAttribute('title', 'This task already has a window')
    })

    it('clicking the (enabled) menu item calls onCreateView and closes the menu', () => {
      seedWindows('main', [])
      const onCreateView = vi.fn()
      renderRow(entry('t1', { name: 'Alpha' }), { onCreateView })
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }))

      fireEvent.click(screen.getByRole('menuitem', { name: '+ New Window From Task' }))

      expect(onCreateView).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('Escape closes the menu and restores focus to what had it before the menu opened', () => {
      seedWindows('main', [])
      render(
        <>
          <button type="button">elsewhere</button>
        </>
      )
      screen.getByRole('button', { name: 'elsewhere' }).focus()
      renderRow(entry('t1', { name: 'Alpha' }), { onCreateView: vi.fn() })

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }))
      expect(screen.getByRole('menu', { name: 'task actions' })).toBeInTheDocument()

      fireEvent.keyDown(screen.getByRole('menu', { name: 'task actions' }), { key: 'Escape' })

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'elsewhere' })).toHaveFocus()
    })

    it('Tab also closes the menu and restores focus', () => {
      seedWindows('main', [])
      render(
        <>
          <button type="button">elsewhere</button>
        </>
      )
      screen.getByRole('button', { name: 'elsewhere' }).focus()
      renderRow(entry('t1', { name: 'Alpha' }), { onCreateView: vi.fn() })

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }))
      fireEvent.keyDown(screen.getByRole('menu', { name: 'task actions' }), { key: 'Tab' })

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'elsewhere' })).toHaveFocus()
    })

    // Shared overlay/menu contract (`.claude/rules/modals-and-overlays.md` /
    // `useKeyboardShortcuts.test.tsx` pattern): every key typed while the menu is
    // focused must be stopped before it reaches the window-level shortcut listener.
    it('stops a session-cycle chord (Ctrl+Shift+ArrowRight) typed in the menu from reaching the window', () => {
      seedWindows('main', [])
      renderRow(entry('t1', { name: 'Alpha' }), { onCreateView: vi.fn() })
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }))
      const menu = screen.getByRole('menu', { name: 'task actions' })

      const spy = vi.fn()
      window.addEventListener('keydown', spy)
      try {
        fireEvent.keyDown(menu, {
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

    it('stops a close-session chord (Ctrl+Shift+KeyW) typed in the menu from reaching the window', () => {
      seedWindows('main', [])
      renderRow(entry('t1', { name: 'Alpha' }), { onCreateView: vi.fn() })
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }))
      const menu = screen.getByRole('menu', { name: 'task actions' })

      const spy = vi.fn()
      window.addEventListener('keydown', spy)
      try {
        fireEvent.keyDown(menu, {
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
  })

  describe('isViewedElsewhere badge', () => {
    it('shows "Viewing in window" when the task has a view OUTSIDE this window\'s group (e.g. from main)', () => {
      seedWindows('main', [windowDTO('view-1', { role: 'view', taskId: 't1' })])
      renderRow(entry('t1', { name: 'Alpha' }))

      expect(screen.getByText('Viewing in window')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Alpha, viewing in window' })).toBeInTheDocument()
    })

    it("omits the badge from inside the task's own view (viewedElsewhere is false there)", () => {
      seedWindows('view-1', [windowDTO('view-1', { role: 'view', taskId: 't1' })])
      renderRow(entry('t1', { name: 'Alpha' }))

      expect(screen.queryByText('Viewing in window')).not.toBeInTheDocument()
    })

    it('omits the badge when the task has no view at all', () => {
      seedWindows('main', [])
      renderRow(entry('t1', { name: 'Alpha' }))

      expect(screen.queryByText('Viewing in window')).not.toBeInTheDocument()
    })
  })

  describe('readOnly row has zero Tab stops', () => {
    it('renders no useSortable drag attributes, a plain name span, a bare issue icon, and no menu trigger', () => {
      seedIssues([issue('i1', { name: 'Fix the thing', status: 'todo', taskId: 't1' })])
      const { container } = renderRow(entry('t1', { name: 'Alpha' }), {
        readOnly: true,
        onCreateView: vi.fn()
      })

      // No focusable/tab-stop element anywhere in the row: no dnd-kit tabIndex on
      // the row, no EditableLabel, no issue-icon <button>, no context menu.
      const tabStops = container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]'
      )
      expect(tabStops).toHaveLength(0)
      // The name renders as plain text, not the editable control.
      expect(screen.getByText('Alpha').tagName).toBe('SPAN')
      // Right-click never opens a menu either (covered above), confirming there is
      // truly nothing interactive left in the row.
      fireEvent.contextMenu(screen.getByText('Alpha'))
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })
})
