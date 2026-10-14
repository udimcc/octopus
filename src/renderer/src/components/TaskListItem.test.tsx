import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, createEvent, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { TaskListItem } from './TaskListItem'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { IssueDTO, TaskDTO } from '../../../shared/dto'
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
