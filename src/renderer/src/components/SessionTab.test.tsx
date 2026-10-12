import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

/** Render a `SessionTab` inside the dnd-kit context `useSortable` requires. */
function renderTab(over: Partial<SessionTabProps> = {}): {
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
    <DndContext>
      <SortableContext items={[props.session.id]}>
        <SessionTab {...props} />
      </SortableContext>
    </DndContext>
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
