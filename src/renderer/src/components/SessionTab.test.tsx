import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { SessionTab, type MoveTarget, type SessionTabProps } from './SessionTab'
import type { SessionDTO } from '../../../shared/dto'

function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 's1',
    taskId: 't1',
    typeId: 'terminal',
    title: 'sh',
    config: { kind: 'terminal' },
    lifecycle: 'running',
    state: 'unknown',
    order: 0,
    createdAt: 1000,
    windowId: 'main',
    ...over
  }
}

/**
 * Render a `SessionTab` inside the dnd-kit context `useSortable` requires. `onWrapperPointerDown`,
 * when given, is a PLAIN (non-dnd-kit) React handler on an outer wrapper div — an ancestor,
 * in React's own event-propagation tree, of the tab root div that dnd-kit's `{...listeners}`
 * is spread onto (`SessionTab.tsx:224-225`). React stops walking that ancestor chain the
 * moment a descendant handler calls `stopPropagation()`, the same mechanism that keeps the
 * group line's pointerdown from reaching the tab root's own dnd-kit listener — so this spy is
 * a faithful stand-in for "did dnd-kit's drag-start listener see this event" without reaching
 * into dnd-kit's internals.
 */
function renderTab(
  over: Partial<SessionTabProps> = {},
  onWrapperPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void
): {
  props: SessionTabProps
} {
  const props: SessionTabProps = {
    session: session(),
    active: false,
    onActivate: vi.fn(),
    onRename: vi.fn(),
    onClose: vi.fn(),
    onNewTerminalFromHere: vi.fn(),
    onMoveToWindow: vi.fn(),
    onRefreshState: vi.fn(),
    moveTargets: [],
    resolveCwd: vi.fn().mockResolvedValue(null),
    canOpenHere: true,
    display: 'idle',
    ...over
  }
  render(
    <div onPointerDown={onWrapperPointerDown}>
      <DndContext>
        <SortableContext items={[props.session.id]}>
          <SessionTab {...props} />
        </SortableContext>
      </DndContext>
    </div>
  )
  return { props }
}

function openMenu(): void {
  fireEvent.contextMenu(screen.getByRole('tab'))
}

describe('<SessionTab> context menu', () => {
  it('opens the menu on right-click and dismisses on Escape', () => {
    renderTab()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    openMenu()
    expect(screen.getByRole('menu', { name: 'session actions' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('dismisses on an outside mousedown', () => {
    renderTab()
    openMenu()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.mouseDown(window)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('hides "new terminal here" for a non-terminal session', () => {
    renderTab({ canOpenHere: false })
    openMenu()
    expect(
      screen.queryByRole('menuitem', { name: 'New terminal from this directory' })
    ).not.toBeInTheDocument()
  })

  it('disables "new terminal here" until the cwd resolves, then fires with it', async () => {
    const onNewTerminalFromHere = vi.fn()
    const resolveCwd = vi.fn().mockResolvedValue('/a/b/c')
    renderTab({ onNewTerminalFromHere, resolveCwd })
    openMenu()

    const item = screen.getByRole('menuitem', { name: 'New terminal from this directory' })
    // Disabled while resolving (cwd === undefined).
    expect(item).toBeDisabled()
    await waitFor(() => expect(item).toBeEnabled())

    fireEvent.click(item)
    expect(onNewTerminalFromHere).toHaveBeenCalledWith('/a/b/c')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('keeps "new terminal here" disabled when the cwd is unavailable (null)', async () => {
    const resolveCwd = vi.fn().mockResolvedValue(null)
    renderTab({ resolveCwd })
    openMenu()
    await waitFor(() => expect(resolveCwd).toHaveBeenCalled())
    expect(
      screen.getByRole('menuitem', { name: 'New terminal from this directory' })
    ).toBeDisabled()
  })

  it('"Rename tab" enters inline edit mode', () => {
    renderTab()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename tab' }))
    expect(screen.getByLabelText('rename session')).toBeInTheDocument()
  })

  it('disables "Move to window" when there are no other windows', () => {
    renderTab({ moveTargets: [] })
    openMenu()
    expect(screen.getByRole('menuitem', { name: 'Move to window' })).toBeDisabled()
  })

  it('lists move targets and fires onMoveToWindow with the chosen id', () => {
    const onMoveToWindow = vi.fn()
    const moveTargets: MoveTarget[] = [{ id: 'w2', label: 'Window 2' }]
    renderTab({ moveTargets, onMoveToWindow })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Window 2' }))
    expect(onMoveToWindow).toHaveBeenCalledWith('w2')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('"Close session" fires onClose', () => {
    const onClose = vi.fn()
    renderTab({ onClose })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close session' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('"Refresh state" fires onRefreshState and dismisses the menu', () => {
    const onRefreshState = vi.fn()
    renderTab({ onRefreshState })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh state' }))
    expect(onRefreshState).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('hides "Refresh state" for a dead session (no state is evaluated)', () => {
    renderTab({ session: session({ lifecycle: 'exited' }) })
    openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Refresh state' })).not.toBeInTheDocument()
  })
})

describe('<SessionTab> split-menu items (§5.7)', () => {
  it('reflects the fresh enablement computed when the menu opens', () => {
    const evaluateSplitEnablement = vi.fn().mockReturnValue({
      splitRightDisabled: true,
      splitDownDisabled: false
    })
    renderTab({ evaluateSplitEnablement })
    openMenu()
    expect(evaluateSplitEnablement).toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeEnabled()
  })

  it('fires onSplitRight/onSplitDown and dismisses the menu', () => {
    const onSplitRight = vi.fn()
    const onSplitDown = vi.fn()
    const evaluateSplitEnablement = vi
      .fn()
      .mockReturnValue({ splitRightDisabled: false, splitDownDisabled: false })
    renderTab({ onSplitRight, onSplitDown, evaluateSplitEnablement })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }))
    expect(onSplitRight).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split down' }))
    expect(onSplitDown).toHaveBeenCalled()
  })

  it('defaults both split items to disabled when no evaluator is supplied', () => {
    renderTab()
    openMenu()
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeDisabled()
  })

  it('hides "Remove from group" for a lone tab (no groupColor)', () => {
    renderTab()
    openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Remove from group' })).not.toBeInTheDocument()
  })

  it('"Remove from group" fires onLeaveGroup and dismisses the menu for a member tab', () => {
    const onLeaveGroup = vi.fn()
    renderTab({ groupColor: '#ff0000', onLeaveGroup })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from group' }))
    expect(onLeaveGroup).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('<SessionTab> group line (§5.7)', () => {
  function getLine(): HTMLElement {
    return screen.getByRole('separator')
  }

  it('renders no group line for a lone tab (groupColor unset)', () => {
    renderTab()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('renders the group line in the given color, spanning only this tab by default', () => {
    renderTab({ groupColor: '#ff00ff' })
    const line = getLine()
    expect(line).toHaveAttribute('data-group-line', 'true')
    // The colored strip is the line's own child; the outer box is just the hit area.
    expect((line.firstElementChild as HTMLElement).style.background).toBe('rgb(255, 0, 255)')
    expect(line.style.right).toBe('0px')
  })

  it('bridges the gap to the next tab when lineBridgesNext is set', () => {
    renderTab({ groupColor: '#ff00ff', lineBridgesNext: true })
    expect(getLine().style.right).toBe('-4px')
  })

  it('labels the line with the group size', () => {
    renderTab({ groupColor: '#ff00ff', groupSize: 3 })
    expect(getLine()).toHaveAttribute('aria-label', 'Group of 3 tabs')
  })

  it('defaults the aria-label to a 2-tab group when groupSize is omitted', () => {
    renderTab({ groupColor: '#ff00ff' })
    expect(getLine()).toHaveAttribute('aria-label', 'Group of 2 tabs')
  })

  it('shows a grab cursor normally and a grabbing cursor while its group is being dragged', () => {
    renderTab({ groupColor: '#ff00ff', groupDragging: false })
    expect(getLine().style.cursor).toBe('grab')
    cleanup()
    renderTab({ groupColor: '#ff00ff', groupDragging: true })
    expect(getLine().style.cursor).toBe('grabbing')
  })

  it('dims the tab itself while its group is being dragged', () => {
    renderTab({ groupColor: '#ff00ff', groupDragging: true })
    expect(screen.getByRole('tab').style.opacity).toBe('0.5')
  })

  it('fires onLinePointerDown on a pointerdown and stops it from reaching the tab', () => {
    const onLinePointerDown = vi.fn()
    const onActivate = vi.fn()
    renderTab({ groupColor: '#ff00ff', onLinePointerDown, onActivate })
    fireEvent.pointerDown(getLine())
    expect(onLinePointerDown).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('fires onLineContextMenu on a right-click and stops it from opening the tab menu', () => {
    const onLineContextMenu = vi.fn()
    renderTab({ groupColor: '#ff00ff', onLineContextMenu })
    fireEvent.contextMenu(getLine())
    expect(onLineContextMenu).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu', { name: 'session actions' })).not.toBeInTheDocument()
  })

  it('stops the pointerdown from reaching an ancestor handler — not just this tab’s own onActivate', () => {
    // `onActivate` alone (the existing test above) only proves a CLICK handler on the
    // immediate tab doesn't fire; it says nothing about `e.stopPropagation()`
    // (SessionTab.tsx:282) actually halting React's own ancestor-handler walk, which is
    // what keeps the group line's pointerdown from ALSO being seen by the tab root's own
    // dnd-kit drag listener (`{...listeners}`, SessionTab.tsx:224-225) one level up.
    const onLinePointerDown = vi.fn()
    const onWrapperPointerDown = vi.fn()
    renderTab({ groupColor: '#ff00ff', onLinePointerDown }, onWrapperPointerDown)
    fireEvent.pointerDown(getLine())
    expect(onLinePointerDown).toHaveBeenCalledTimes(1)
    // If SessionTab.tsx:282's `e.stopPropagation()` were ever removed, this ancestor
    // handler — standing in for dnd-kit's own, which sits at the SAME ancestry distance —
    // would fire too.
    expect(onWrapperPointerDown).not.toHaveBeenCalled()
  })

  it('a plain click on the line is swallowed — it neither activates the tab nor bubbles', () => {
    const onActivate = vi.fn()
    renderTab({ groupColor: '#ff00ff', onActivate })
    fireEvent.click(getLine())
    expect(onActivate).not.toHaveBeenCalled()
  })
})

describe('<SessionTab> focus flash (§5.4)', () => {
  it('adds the flash class only while `flash` is set', () => {
    renderTab({ active: true, flash: true })
    expect(screen.getByRole('tab')).toHaveClass('session-tab', 'session-tab--focus-flash')
  })

  it('renders the plain tab by default', () => {
    renderTab({ active: true })
    expect(screen.getByRole('tab')).not.toHaveClass('session-tab--focus-flash')
  })
})
