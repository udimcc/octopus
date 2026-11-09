import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, fireEvent, within } from '@testing-library/react'
import { KanbanBoard } from './KanbanBoard'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { IssueDTO, TaskDTO, WindowedWorkspaceStateDTO } from '../../../shared/dto'

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
  // KanbanBoard is normally embedded in the (open) Issues drawer; open it directly
  // here since this file renders the board standalone.
  useStore.setState({ issuesDrawerOpen: true })
}

/** A column `<section aria-label=…>` gets the implicit ARIA role "region" since it
 * carries an accessible name (verified empirically — plain `<section>` has none). */
function column(label: string): HTMLElement {
  return screen.getByRole('region', { name: label })
}

/** The real card `<button>` for `name`, disambiguated from the portaled drag-ghost
 * `<div>` (same text, rendered to `document.body` while dragging) by requiring a
 * `<button>` ancestor — the ghost is a non-interactive `<div>` (see `KanbanCard`). */
function cardButton(name: string): HTMLElement {
  const spans = screen.getAllByText(name, { selector: 'span' })
  const btn = spans.map((s) => s.closest('button')).find((b): b is HTMLButtonElement => b !== null)
  if (!btn) throw new Error(`card for "${name}" not found`)
  return btn
}

/**
 * jsdom has no real `PointerEvent` constructor and no `elementFromPoint`/pointer
 * capture implementation — this file's manual pointer-capture drag (`KanbanBoard`'s
 * `startCardDrag`, modeled on `SplitDividers`/`SessionTabBar`) needs all three
 * stubbed, the same way `SessionTabBar.test.tsx` does for its own group-line drag.
 */
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class PointerEvent extends (
    MouseEvent
  ) {}
}

function firePointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  target: Element | Document | Window,
  props: { pointerId: number; clientX?: number; clientY?: number; button?: number }
): void {
  const Ctor = (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent
  const event = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    clientX: props.clientX ?? 0,
    clientY: props.clientY ?? 0,
    button: props.button ?? 0
  })
  Object.defineProperty(event, 'pointerId', { value: props.pointerId })
  fireEvent(target, event)
}

describe('<KanbanBoard>', () => {
  let originalSetPointerCapture: PropertyDescriptor | undefined
  let originalHasPointerCapture: PropertyDescriptor | undefined
  let originalReleasePointerCapture: PropertyDescriptor | undefined
  let originalElementFromPoint: PropertyDescriptor | undefined

  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()

    originalSetPointerCapture = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'setPointerCapture'
    )
    originalHasPointerCapture = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'hasPointerCapture'
    )
    originalReleasePointerCapture = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'releasePointerCapture'
    )
    originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')

    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn()
    })
    Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: vi.fn(() => true)
    })
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn()
    })
    // Default: no column under the pointer. Individual tests override via
    // `dropOn(element)`.
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null)
    })
  })

  afterEach(() => {
    const restore = (obj: object, prop: string, original: PropertyDescriptor | undefined): void => {
      if (original) {
        Object.defineProperty(obj, prop, original)
      } else {
        delete (obj as unknown as Record<string, unknown>)[prop]
      }
    }
    restore(HTMLElement.prototype, 'setPointerCapture', originalSetPointerCapture)
    restore(HTMLElement.prototype, 'hasPointerCapture', originalHasPointerCapture)
    restore(HTMLElement.prototype, 'releasePointerCapture', originalReleasePointerCapture)
    restore(document, 'elementFromPoint', originalElementFromPoint)
  })

  /** Makes `document.elementFromPoint` return `el` for every subsequent call. */
  function dropOn(el: Element | null): void {
    vi.mocked(document.elementFromPoint).mockReturnValue(el)
  }

  /** down → move past the threshold → up, all on `btn`, dropping wherever `dropOn`
   * last pointed. Returns nothing; callers assert on store/mock state afterward. */
  function dragAndDrop(btn: HTMLElement, opts: { pointerId?: number } = {}): void {
    const pointerId = opts.pointerId ?? 1
    firePointer('pointerdown', btn, { pointerId, clientX: 100, clientY: 100 })
    firePointer('pointermove', btn, { pointerId, clientX: 120, clientY: 100 }) // past the 4px threshold
    firePointer('pointerup', btn, { pointerId, clientX: 120, clientY: 100 })
  }

  describe('static rendering', () => {
    it('always renders all 5 columns, in order, each with a count', () => {
      seed([
        issue('t1', { status: 'todo' }),
        issue('t2', { status: 'todo' }),
        issue('p1', { status: 'in_progress' }),
        issue('b1', { status: 'blocked' }),
        issue('r1', { status: 'in_review' })
      ])
      render(<KanbanBoard />)
      const todo = column('Todo')
      const inProgress = column('In progress')
      const blocked = column('Blocked')
      const inReview = column('In review')
      const done = column('Done')
      const sections = screen.getAllByRole('region')
      expect(sections).toEqual([todo, inProgress, blocked, inReview, done])
      expect(within(todo).getByText('2')).toBeInTheDocument()
      expect(within(inProgress).getByText('1')).toBeInTheDocument()
      expect(within(blocked).getByText('1')).toBeInTheDocument()
      expect(within(inReview).getByText('1')).toBeInTheDocument()
      expect(within(done).getByText('0')).toBeInTheDocument()
    })

    it('puts cards in the right column, newest first within it', () => {
      seed([
        issue('old', { status: 'todo', createdAt: 1000, name: 'Old one' }),
        issue('new', { status: 'todo', createdAt: 2000, name: 'New one' }),
        issue('p1', { status: 'in_progress', name: 'In flight' })
      ])
      render(<KanbanBoard />)
      const todoCards = within(column('Todo'))
        .getAllByRole('button')
        .filter((b) => b.hasAttribute('aria-pressed'))
      expect(todoCards.map((b) => b.textContent)).toEqual([
        expect.stringContaining('New one'),
        expect.stringContaining('Old one')
      ])
      expect(within(column('In progress')).getByText('In flight')).toBeInTheDocument()
    })

    it('shows "No issues" in an empty column', () => {
      seed([issue('t1', { status: 'todo' })])
      render(<KanbanBoard />)
      expect(within(column('Done')).getByText('No issues')).toBeInTheDocument()
      expect(within(column('Todo')).queryByText('No issues')).not.toBeInTheDocument()
    })

    it('a click selects the issue via selectIssue, and highlights the card as aria-pressed', () => {
      seed([issue('i1', { name: 'Pick me' }), issue('i2', { name: 'Not me' })])
      render(<KanbanBoard />)
      const pick = cardButton('Pick me')
      const notMe = cardButton('Not me')
      expect(pick).toHaveAttribute('aria-pressed', 'false')

      fireEvent.click(pick)
      expect(useStore.getState().selectedIssueId).toBe('i1')
      expect(pick).toHaveAttribute('aria-pressed', 'true')
      expect(notMe).toHaveAttribute('aria-pressed', 'false')
    })

    it('a click while the open issue has unsaved edits raises the discard prompt instead of switching', () => {
      seed([issue('i1', { name: 'Current' }), issue('i2', { name: 'Other' })])
      act(() => {
        useStore.getState().selectIssue('i1')
        useStore.getState().setIssueEditDirty(true)
      })
      render(<KanbanBoard />)
      fireEvent.click(cardButton('Other'))
      expect(useStore.getState().selectedIssueId).toBe('i1')
      expect(useStore.getState().discardPrompt).toEqual({ kind: 'select', issueId: 'i2' })
    })
  })

  describe('drag and drop', () => {
    it('a drop on another column calls issues.update with the new status', () => {
      seed([issue('i1', { name: 'Movable', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('In progress'))
      act(() => dragAndDrop(cardButton('Movable')))
      expect(window.octopusAPI.issues.update).toHaveBeenCalledWith({
        issueId: 'i1',
        status: 'in_progress'
      })
    })

    it('a drop on the Blocked column calls issues.update with status blocked and no reasons', () => {
      seed([issue('i1', { name: 'Stuck', status: 'in_progress' })])
      render(<KanbanBoard />)
      dropOn(column('Blocked'))
      act(() => dragAndDrop(cardButton('Stuck')))
      expect(window.octopusAPI.issues.update).toHaveBeenCalledWith({
        issueId: 'i1',
        status: 'blocked'
      })
    })

    it('a same-column drop makes no call', () => {
      seed([issue('i1', { name: 'Stays', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('Todo'))
      act(() => dragAndDrop(cardButton('Stays')))
      expect(window.octopusAPI.issues.update).not.toHaveBeenCalled()
    })

    it('a drop outside every column (elementFromPoint returns null) makes no call', () => {
      seed([issue('i1', { name: 'Nowhere', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(null)
      act(() => dragAndDrop(cardButton('Nowhere')))
      expect(window.octopusAPI.issues.update).not.toHaveBeenCalled()
    })

    it('movement below the threshold is a click, not a drag', () => {
      seed([issue('i1', { name: 'Clicky', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('In progress'))
      const btn = cardButton('Clicky')
      firePointer('pointerdown', btn, { pointerId: 1, clientX: 100, clientY: 100 })
      firePointer('pointermove', btn, { pointerId: 1, clientX: 102, clientY: 100 }) // 2px, under 4px
      firePointer('pointerup', btn, { pointerId: 1, clientX: 102, clientY: 100 })
      fireEvent.click(btn)
      expect(window.octopusAPI.issues.update).not.toHaveBeenCalled()
      expect(useStore.getState().selectedIssueId).toBe('i1')
    })

    it('Esc mid-drag cancels with no call, and a window bubble-phase keydown listener never sees it', () => {
      seed([issue('i1', { name: 'Escapable', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('In progress'))
      const btn = cardButton('Escapable')
      const bubbleSpy = vi.fn()
      window.addEventListener('keydown', bubbleSpy) // bubble phase
      try {
        firePointer('pointerdown', btn, { pointerId: 1, clientX: 100, clientY: 100 })
        firePointer('pointermove', btn, { pointerId: 1, clientX: 120, clientY: 100 })
        fireEvent.keyDown(window, { key: 'Escape' })
        firePointer('pointerup', btn, { pointerId: 1, clientX: 120, clientY: 100 })

        expect(window.octopusAPI.issues.update).not.toHaveBeenCalled()
        expect(bubbleSpy).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener('keydown', bubbleSpy)
      }
    })

    it('closing the drawer mid-drag cancels it', () => {
      seed([issue('i1', { name: 'DrawerCloses', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('In progress'))
      const btn = cardButton('DrawerCloses')
      firePointer('pointerdown', btn, { pointerId: 1, clientX: 100, clientY: 100 })
      firePointer('pointermove', btn, { pointerId: 1, clientX: 120, clientY: 100 })

      act(() => useStore.setState({ issuesDrawerOpen: false }))

      firePointer('pointerup', btn, { pointerId: 1, clientX: 120, clientY: 100 })
      expect(window.octopusAPI.issues.update).not.toHaveBeenCalled()
    })

    it('the selection is unchanged after a drop', () => {
      seed([
        issue('i1', { name: 'Selected one', status: 'todo' }),
        issue('i2', { name: 'Dragged one', status: 'todo' })
      ])
      act(() => useStore.getState().selectIssue('i1'))
      render(<KanbanBoard />)
      dropOn(column('In progress'))
      act(() => dragAndDrop(cardButton('Dragged one')))
      expect(useStore.getState().selectedIssueId).toBe('i1')
    })

    it('a drop on an empty column works', () => {
      seed([issue('i1', { name: 'IntoEmpty', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('Done'))
      act(() => dragAndDrop(cardButton('IntoEmpty')))
      expect(window.octopusAPI.issues.update).toHaveBeenCalledWith({
        issueId: 'i1',
        status: 'done'
      })
    })

    it('an issues.update rejection shows an error toast', async () => {
      installStubBridge({ ack: () => Promise.reject(new Error('network down')) as never })
      seed([issue('i1', { name: 'Failing', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('In progress'))
      await act(async () => {
        dragAndDrop(cardButton('Failing'))
        await new Promise((r) => setTimeout(r, 0))
      })
      const toasts = useStore.getState().toasts
      expect(toasts.at(-1)?.kind).toBe('error')
    })

    it('the click right after a drop does not select the card, but a later real click does', async () => {
      seed([issue('i1', { name: 'PostDrop', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('In progress'))
      // Synchronous act(): dragAndDrop itself is synchronous, and using the async
      // act() form here would let React's internal scheduler flush consume a real
      // macrotask tick — which can race with the production `setTimeout(..., 0)`
      // that clears the one-shot click-suppression flag, making the very next
      // assertion flaky. Keep this act() synchronous so no real timer can run
      // between the drop and the immediately-following click.
      act(() => dragAndDrop(cardButton('PostDrop')))
      expect(useStore.getState().selectedIssueId).toBeUndefined()

      // The click synthesized by the browser right after the same pointerup — swallowed.
      fireEvent.click(cardButton('PostDrop'))
      expect(useStore.getState().selectedIssueId).toBeUndefined()

      // Flush the macrotask that clears the one-shot suppression flag.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      // A later, independent click selects normally.
      fireEvent.click(cardButton('PostDrop'))
      expect(useStore.getState().selectedIssueId).toBe('i1')
    })
  })

  describe('edge cases', () => {
    it('a linked issue dropped on Done gets only a status update — no link/unlink call', () => {
      seed(
        [issue('i1', { name: 'Linked', status: 'todo', taskId: 't1' })],
        [task('t1', { name: 'Bound task' })]
      )
      render(<KanbanBoard />)
      dropOn(column('Done'))
      act(() => dragAndDrop(cardButton('Linked')))
      expect(window.octopusAPI.issues.update).toHaveBeenCalledWith({
        issueId: 'i1',
        status: 'done'
      })
      expect(window.octopusAPI.issues.bind).not.toHaveBeenCalled()
      expect(window.octopusAPI.issues.unbind).not.toHaveBeenCalled()
    })

    it('the dragged issue being deleted mid-drag cancels the drag', () => {
      seed([issue('i1', { name: 'Vanishing', status: 'todo' })])
      render(<KanbanBoard />)
      dropOn(column('In progress'))
      const btn = cardButton('Vanishing')
      firePointer('pointerdown', btn, { pointerId: 1, clientX: 100, clientY: 100 })
      firePointer('pointermove', btn, { pointerId: 1, clientX: 120, clientY: 100 })

      act(() => useStore.getState().applyEvent({ type: 'issueDeleted', issueId: 'i1' }))

      // The card (and its gesture) are gone; nothing left to release onto, and no
      // command is sent even if a stray pointerup for that id arrives on window.
      firePointer('pointerup', window, { pointerId: 1, clientX: 120, clientY: 100 })
      expect(window.octopusAPI.issues.update).not.toHaveBeenCalled()
    })
  })
})
