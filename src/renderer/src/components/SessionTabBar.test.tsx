import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SessionTabBar } from './SessionTabBar'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import {
  registerPaneMetrics,
  unregisterPaneMetrics,
  _resetPaneMetrics
} from '../terminal/terminal-metrics'
import { GROUP_COLOR_PALETTE } from '../style/tokens'
import type { SessionDTO, SessionTypeDTO, TaskDTO, GroupDTO, SplitNode } from '../../../shared/dto'

function leaf(sessionId: string): SplitNode {
  return { kind: 'leaf', sessionId }
}

/** A row split of two leaves — the shape a group's `layout` takes (§5.7). */
function rowSplit(aId: string, bId: string): SplitNode {
  return { kind: 'split', dir: 'row', ratio: 0.5, a: leaf(aId), b: leaf(bId) }
}

function group(id: string, layout: SplitNode, colorIndex = 0): GroupDTO {
  return { id, layout, colorIndex }
}

/** `#rrggbb` -> `rgb(r, g, b)`, matching how jsdom normalizes an inline `style.background`
 * when read back. */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgb(${r}, ${g}, ${b})`
}

/** Look up a tab by its session title. */
function getTab(name: string): HTMLElement {
  const tab = screen.getAllByRole('tab').find((t) => t.textContent?.includes(name))
  if (!tab) throw new Error(`no tab found for ${name}`)
  return tab
}

/** The group-line strip inside a given tab (§5.7) — absent for a lone tab. */
function queryGroupLine(name: string): HTMLElement | null {
  return getTab(name).querySelector('[data-group-line="true"]')
}

function getGroupLine(name: string): HTMLElement {
  const line = queryGroupLine(name)
  if (!line) throw new Error(`no group line for ${name}`)
  return line
}

function openTabMenu(name: string): void {
  fireEvent.contextMenu(getTab(name))
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

const TERMINAL_TYPE: SessionTypeDTO = {
  typeId: 'terminal',
  displayName: 'Terminal',
  icon: '',
  availableFromVersion: 1,
  configSchema: {}
}

function seed(opts: {
  lifecycle?: string
  sessions?: SessionDTO[]
  sessionTypes?: SessionTypeDTO[]
  groups?: GroupDTO[]
}): void {
  const sessions = opts.sessions ?? []
  const t: TaskDTO = {
    id: 't1',
    name: 'Alpha',
    lifecycle: opts.lifecycle ?? 'ready',
    state: 'unknown',
    sessions,
    activeSessionId: sessions[0]?.id,
    position: 0,
    createdAt: 1000,
    groups: opts.groups ?? []
  }
  useStore.getState().hydrate({
    tasks: [t],
    activeTaskId: 't1',
    sessionTypes: opts.sessionTypes ?? [TERMINAL_TYPE],
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
    windows: []
  })
}

describe('<SessionTabBar>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('renders a tab per session, with an (exited) suffix on dead ones', () => {
    seed({
      sessions: [
        session('s1', { title: 'sh' }),
        session('s2', { title: 'build', lifecycle: 'exited', order: 1 })
      ]
    })
    render(<SessionTabBar taskId="t1" />)
    expect(screen.getByRole('tab', { name: 'sh' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'build' })).toBeInTheDocument()
    expect(screen.getByText('(exited)')).toBeInTheDocument()
  })

  it('activates a session on click: local pointer + backend round-trip', () => {
    seed({ sessions: [session('s1'), session('s2', { order: 1 })] })
    render(<SessionTabBar taskId="t1" />)
    fireEvent.click(screen.getByRole('tab', { name: 's2' }))
    // Local pointer moves for instant feedback…
    expect(useStore.getState().activeSessionByTask.t1).toBe('s2')
    // …AND the switch round-trips so the pointer persists (I10) and every window is
    // told via `activeSessionChanged` — the cross-window ready-for-review clear (§9.5).
    expect(window.octopusAPI.sessions.switch).toHaveBeenCalledWith({ sessionId: 's2' })
  })

  it('closes a session via its × button', () => {
    seed({ sessions: [session('s1')] })
    render(<SessionTabBar taskId="t1" />)
    fireEvent.click(screen.getByRole('button', { name: 'close session' }))
    expect(window.octopusAPI.sessions.close).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('creates a terminal session immediately (single type) when ready', () => {
    seed({ lifecycle: 'ready', sessions: [] })
    render(<SessionTabBar taskId="t1" />)
    fireEvent.click(screen.getByRole('button', { name: 'new session' }))
    expect(window.octopusAPI.sessions.create).toHaveBeenCalledWith({
      taskId: 't1',
      typeId: 'terminal'
    })
  })

  it('disables new-session while the task is not ready', () => {
    seed({ lifecycle: 'provisioning', sessions: [] })
    render(<SessionTabBar taskId="t1" />)
    expect(screen.getByRole('button', { name: 'new session' })).toBeDisabled()
  })

  it('a working session with a stale review flag shows the Working icon, not review (§9.5)', () => {
    // The gating flows through `sessionDisplayState`: even though s1 still carries a
    // ready-for-review flag (raised earlier on working→waiting), its CURRENT state is
    // working, so the tab must show the spinning Working icon — the bug this fixes.
    seed({ sessions: [session('s1', { title: 'sh', state: 'working' })] })
    useStore.setState({ hasUnseenFinishedTurn: { s1: true } })
    render(<SessionTabBar taskId="t1" />)
    const tab = screen.getByRole('tab', { name: 'sh' })
    expect(tab.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Working')
  })

  it('an idle session with a finished-unseen flag, OFF screen, shows the Ready-for-review icon (§9.5)', () => {
    seed({ sessions: [session('s1', { title: 'sh', state: 'waiting' })] })
    // Off screen: the window is blurred, so the finished-unseen turn surfaces as review.
    useStore.setState({ hasUnseenFinishedTurn: { s1: true }, windowFocused: false })
    render(<SessionTabBar taskId="t1" />)
    const tab = screen.getByRole('tab', { name: 'sh' })
    expect(tab.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ready for review')
  })

  it('an idle session with a finished-unseen flag but ON screen shows Idle — review is suppressed (§9.5)', () => {
    // seed() makes s1 the active tab of the active task in the (focused) main window, so
    // s1 is on screen: the review dot is suppressed at display time even with the flag set.
    seed({ sessions: [session('s1', { title: 'sh', state: 'waiting' })] })
    useStore.setState({ hasUnseenFinishedTurn: { s1: true }, windowFocused: true })
    render(<SessionTabBar taskId="t1" />)
    const tab = screen.getByRole('tab', { name: 'sh' })
    expect(tab.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Idle')
  })

  it('keeps THIS window’s tab marked when the focus moves to another window (§3.7)', () => {
    seed({
      sessions: [
        session('s1'),
        session('s2', { order: 1 }),
        session('s3', { order: 2, windowId: 'win-2' })
      ]
    })
    useStore.getState().setActiveSession('t1', 's2')
    render(<SessionTabBar taskId="t1" />)
    // A cross-window switch to s3 (hosted in win-2) must not unmark s2 here.
    act(() => {
      useStore.getState().applyEvent({
        type: 'activeSessionChanged',
        taskId: 't1',
        sessionId: 's3',
        windowId: 'win-2'
      })
    })
    expect(screen.getByRole('tab', { name: 's2' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 's3' })).not.toBeInTheDocument()
  })

  it('flashes only the marked tab of the active task while the focus flash is on (§5.4)', () => {
    seed({ sessions: [session('s1'), session('s2', { order: 1 })] })
    useStore.getState().setActiveSession('t1', 's2')
    useStore.setState({ focusFlashOn: true, focusFlashSeq: 1 })
    render(<SessionTabBar taskId="t1" />)
    expect(screen.getByRole('tab', { name: 's2' })).toHaveClass('session-tab--focus-flash')
    expect(screen.getByRole('tab', { name: 's1' })).not.toHaveClass('session-tab--focus-flash')
    act(() => useStore.getState().endFocusFlash(1))
    expect(screen.getByRole('tab', { name: 's2' })).not.toHaveClass('session-tab--focus-flash')
  })

  it('does not flash a kept-alive task that is not the active one (§5.3)', () => {
    seed({ sessions: [session('s1')] })
    useStore.setState({ focusFlashOn: true, focusFlashSeq: 1, activeTaskId: 'other' })
    render(<SessionTabBar taskId="t1" />)
    expect(screen.getByRole('tab', { name: 's1' })).not.toHaveClass('session-tab--focus-flash')
  })

  it('offers a dropdown menu when more than one session type is available', () => {
    seed({
      lifecycle: 'ready',
      sessions: [],
      sessionTypes: [TERMINAL_TYPE, { ...TERMINAL_TYPE, typeId: 'jenkins', displayName: 'Jenkins' }]
    })
    render(<SessionTabBar taskId="t1" />)
    // With >1 type, the button opens a menu rather than creating immediately.
    fireEvent.click(screen.getByRole('button', { name: 'new session' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Jenkins' }))
    expect(window.octopusAPI.sessions.create).toHaveBeenCalledWith({
      taskId: 't1',
      typeId: 'jenkins'
    })
  })
})

/**
 * jsdom has no `PointerEvent` constructor at all (see `SplitDividers.test.tsx`'s identical
 * note) — but unlike the manual gutter/group-line drags (which only read `clientX`/
 * `clientY`/`pointerId` structurally off a plain `MouseEvent`), dnd-kit's own
 * `SessionTabBar.onDragStart` does `activator instanceof PointerEvent` on the activating
 * event, which throws `ReferenceError` if the global is simply missing rather than false.
 * A minimal subclass (real Chromium/Electron always has one; only jsdom doesn't) makes
 * that check behave as it would in the real app, without altering any production code.
 */
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class PointerEvent extends (
    MouseEvent
  ) {}
}

function firePointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
  target: Element | Document,
  props: {
    pointerId: number
    clientX?: number
    clientY?: number
    screenX?: number
    screenY?: number
    button?: number
    isPrimary?: boolean
  }
): void {
  const Ctor = (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent
  const event = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    clientX: props.clientX ?? 0,
    clientY: props.clientY ?? 0,
    screenX: props.screenX ?? props.clientX ?? 0,
    screenY: props.screenY ?? props.clientY ?? 0,
    button: props.button ?? 0
  })
  Object.defineProperty(event, 'pointerId', { value: props.pointerId })
  Object.defineProperty(event, 'isPrimary', { value: props.isPrimary ?? true })
  fireEvent(target, event)
}

interface RectLike {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly right: number
  readonly bottom: number
  readonly x: number
  readonly y: number
}

/** A 100px-wide slot at `index * 100`, `height` 30 — tabs/lines laid left-to-right. */
function rectAt(index: number): RectLike {
  const left = index * 100
  return { left, top: 0, width: 100, height: 30, right: left + 100, bottom: 30, x: left, y: 0 }
}

const FALLBACK_RECT: RectLike = {
  left: 0,
  top: 0,
  width: 2000,
  height: 40,
  right: 2000,
  bottom: 40,
  x: 0,
  y: 0
}

describe('<SessionTabBar> split groups (§5.7)', () => {
  // Keyed by session id; set per test via `setTabRects`. Read by the stubbed
  // `getBoundingClientRect` below so both dnd-kit's own collision detection and the
  // manual group-line drag (`startGroupDrag`/`finishGroupDrag`, modeled on
  // `SplitDividers`'s gutter drag) see predictable, deterministic tab positions.
  let tabRects: Record<string, RectLike>
  let originalGetBoundingClientRect: PropertyDescriptor | undefined
  let originalSetPointerCapture: PropertyDescriptor | undefined
  let originalHasPointerCapture: PropertyDescriptor | undefined
  let originalReleasePointerCapture: PropertyDescriptor | undefined

  function setTabRects(rects: Record<string, RectLike>): void {
    tabRects = rects
  }

  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
    tabRects = {}

    originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'getBoundingClientRect'
    )
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

    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        const sid = this.dataset.sessionId
        return (sid && tabRects[sid]) || FALLBACK_RECT
      }
    })
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
  })

  afterEach(() => {
    const restore = (prop: string, original: PropertyDescriptor | undefined): void => {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, prop, original)
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
      }
    }
    restore('getBoundingClientRect', originalGetBoundingClientRect)
    restore('setPointerCapture', originalSetPointerCapture)
    restore('hasPointerCapture', originalHasPointerCapture)
    restore('releasePointerCapture', originalReleasePointerCapture)
    _resetPaneMetrics()
  })

  it('colors each grouped tab line from the group palette, bridging the gap between adjacent members', () => {
    seed({
      sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
      groups: [group('g1', rowSplit('s1', 's2'), 1)]
    })
    render(<SessionTabBar taskId="t1" />)

    const line1 = getGroupLine('s1')
    const line2 = getGroupLine('s2')
    expect((line1.firstElementChild as HTMLElement).style.background).toBe(
      hexToRgb(GROUP_COLOR_PALETTE[1])
    )
    // s1 bridges the gap to its fellow member s2; s2 is the group's last member — no bridge.
    expect(line1.style.right).toBe('-4px')
    expect(line2.style.right).toBe('0px')
    // s3 is lone — no line at all.
    expect(queryGroupLine('s3')).not.toBeInTheDocument()
  })

  it('labels the line with the live member count', () => {
    seed({
      sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    render(<SessionTabBar taskId="t1" />)
    expect(getGroupLine('s1')).toHaveAttribute('aria-label', 'Group of 2 tabs')
  })

  it('a sub-threshold release on the line is a plain click — no reorder/move/detach, even when its nearest tab is a non-member', () => {
    // Real rects (not the FALLBACK_RECT every tab got before this fix): s2 sits at
    // index 1 (left 100-200), s3 — a non-member — at index 2 (left 200-300). Pointerdown
    // just inside s2 at 199, release 3px later at 202 — under GROUP_DRAG_THRESHOLD_PX
    // (4) — lands just inside non-member s3's slot. Without a real `setTabRects`, every
    // tab reads FALLBACK_RECT and the hit-test always lands back on member s1
    // regardless of the threshold gate, so the old version of this test passed even
    // with the threshold check deleted. This fixture only passes if the threshold gate
    // (SessionTabBar.tsx:379) genuinely suppresses the drag — if it didn't, `dragging`
    // would go true and `finishGroupDrag` would hit-test the release position, find
    // non-member s3, and issue a `groups.reorder`.
    seed({
      sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    setTabRects({ s1: rectAt(0), s2: rectAt(1), s3: rectAt(2) })
    render(<SessionTabBar taskId="t1" />)

    const line = getGroupLine('s2')
    firePointer('pointerdown', line, { pointerId: 1, screenX: 199, screenY: 15, clientX: 199 })
    // 3px of movement — below GROUP_DRAG_THRESHOLD_PX (4).
    firePointer('pointermove', line, { pointerId: 1, screenX: 202, screenY: 15, clientX: 202 })
    firePointer('pointerup', line, { pointerId: 1, screenX: 202, screenY: 15, clientX: 202 })

    expect(window.octopusAPI.groups.reorder).not.toHaveBeenCalled()
    expect(window.octopusAPI.sessions.move).not.toHaveBeenCalled()
    expect(window.octopusAPI.windows.createWithSession).not.toHaveBeenCalled()
  })

  it('ignores a non-primary-button press on the line — no drag starts even with real movement', () => {
    seed({
      sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    setTabRects({ s1: rectAt(0), s2: rectAt(1), s3: rectAt(2) })
    render(<SessionTabBar taskId="t1" />)

    const line = getGroupLine('s2')
    firePointer('pointerdown', line, {
      pointerId: 1,
      screenX: 150,
      screenY: 15,
      clientX: 150,
      button: 2
    })
    firePointer('pointermove', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })
    firePointer('pointerup', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })

    expect(window.octopusAPI.groups.reorder).not.toHaveBeenCalled()
    // `opacity` is an inline style, not a class — `.not.toHaveClass(/opacity/)` always
    // passes regardless of dimming. Read the actual inline style instead.
    expect(screen.getByRole('tab', { name: 's2' }).style.opacity).toBe('1') // no dimming either
  })

  it('dims the group’s tabs only after crossing the drag threshold, not immediately on pointerdown', () => {
    seed({
      sessions: [session('s1'), session('s2', { order: 1 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    setTabRects({ s1: rectAt(0), s2: rectAt(1) })
    render(<SessionTabBar taskId="t1" />)

    const line = getGroupLine('s1')
    firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
    expect(getTab('s1').style.opacity).toBe('1')
    expect(getTab('s2').style.opacity).toBe('1')

    // 2px — still below GROUP_DRAG_THRESHOLD_PX (4): must stay un-dimmed.
    firePointer('pointermove', line, { pointerId: 1, screenX: 52, screenY: 15, clientX: 52 })
    expect(getTab('s1').style.opacity).toBe('1')
    expect(getTab('s2').style.opacity).toBe('1')

    // Past the threshold now — both members of the dragged group dim.
    firePointer('pointermove', line, { pointerId: 1, screenX: 60, screenY: 15, clientX: 60 })
    expect(getTab('s1').style.opacity).toBe('0.5')
    expect(getTab('s2').style.opacity).toBe('0.5')

    firePointer('pointerup', line, { pointerId: 1, screenX: 60, screenY: 15, clientX: 60 })
  })

  it('right-clicking the line opens "Ungroup", which calls groups.ungroup', () => {
    seed({
      sessions: [session('s1'), session('s2', { order: 1 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    render(<SessionTabBar taskId="t1" />)

    fireEvent.contextMenu(getGroupLine('s1'))
    expect(screen.getByRole('menu', { name: 'group actions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ungroup' }))

    expect(window.octopusAPI.groups.ungroup).toHaveBeenCalledWith({ taskId: 't1', groupId: 'g1' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('dragging the group line past the threshold reorders the whole group via groups.reorder, against the FULL cross-window order (IMP4)', () => {
    // s1+s2 are grouped and both hosted in `main`; s3 is hosted in ANOTHER window — it
    // never renders in this bar at all — but still occupies order 2 in the task's full
    // cross-window order, between the group and lone s4. (The group's own members must
    // stay contiguous and share one window per DESIGN §5.7 — s3 merely rides between the
    // GROUP and s4 in the full order, not between the group's own two members, so this
    // fixture is realistic, unlike grouping s1+s3 with s2 wedged between them would be.)
    // A window-filtered computation (dropping s3 because it's never rendered here) would
    // wrongly compute toIndex against ['s1','s4'] instead of the real ['s1','s3','s4'].
    seed({
      sessions: [
        session('s1', { order: 0 }),
        session('s2', { order: 1 }),
        session('s3', { order: 2, windowId: 'other' }),
        session('s4', { order: 3 })
      ],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    // Rendered (window-filtered) order is s1, s2, s4 — the group's line drag hit-tests
    // against these DOM rects.
    setTabRects({ s1: rectAt(0), s2: rectAt(1), s4: rectAt(2) })
    render(<SessionTabBar taskId="t1" />)

    const line = getGroupLine('s1') // group's first member — the drag's representative
    firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
    // Past GROUP_DRAG_THRESHOLD_PX (4) toward s4's slot. Real `clientX` (not just
    // `screenX`) is set so that, if the line's `stopPropagation` (SessionTab.tsx:282)
    // ever regressed, dnd-kit's own PointerSensor on the underlying tab (activation
    // distance 4px) would see genuine coordinate movement and activate — making such a
    // regression observable via the member tab's own `isDragging`-driven opacity below,
    // not silently masked by an all-zero clientX.
    firePointer('pointermove', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })
    // Mid-drag: the group's own manual drag has dimmed the tab (groupDragging), but
    // dnd-kit's own sortable drag on the SAME underlying tab must never have activated
    // in parallel — proving the group line and the tab's own dnd-kit listener stay
    // mutually exclusive even with real pointer movement available to both.
    expect(getTab('s1').style.opacity).toBe('0.5')
    firePointer('pointerup', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })

    // moveList excludes s2 (the group's other member): ['s1','s3','s4'] (s1 the rep;
    // s3 — hosted elsewhere, never rendered — still counted).
    // arrayMove(['s1','s3','s4'], 0, 2) -> ['s3','s4','s1']; indexOf('s1') = 2.
    expect(window.octopusAPI.groups.reorder).toHaveBeenCalledWith({
      taskId: 't1',
      groupId: 'g1',
      toIndex: 2
    })
  })

  it('a failed groups.reorder ack surfaces an error toast', async () => {
    installStubBridge({ ack: () => ({ ok: false, error: 'Cannot move group there' }) })
    seed({
      sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    setTabRects({ s1: rectAt(0), s2: rectAt(1), s3: rectAt(2) })
    render(<SessionTabBar taskId="t1" />)

    const line = getGroupLine('s1')
    await act(async () => {
      firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15 })
      firePointer('pointermove', line, { pointerId: 1, screenX: 250, screenY: 15 })
      firePointer('pointerup', line, { pointerId: 1, screenX: 250, screenY: 15 })
    })

    const toasts = useStore.getState().toasts
    expect(toasts.at(-1)?.kind).toBe('error')
    expect(toasts.at(-1)?.message).toBe('Cannot move group there')
  })

  describe('group-line drop OUTSIDE the bar (whole-group detach/move, SessionTabBar.tsx:296-300)', () => {
    it('detaches the MARK (a member) via createWithSession when dropped on an empty desktop', async () => {
      seed({
        sessions: [session('s1'), session('s2', { order: 1 })],
        groups: [group('g1', rowSplit('s1', 's2'), 0)]
      })
      setTabRects({ s1: rectAt(0), s2: rectAt(1) })
      useStore.getState().setActiveSession('t1', 's2') // mark = s2, a member of g1
      render(<SessionTabBar taskId="t1" />)

      const line = getGroupLine('s1')
      await act(async () => {
        firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
        // Far below the bar (FALLBACK_RECT height 40 + 20px margin) — outside on any x.
        firePointer('pointermove', line, { pointerId: 1, screenX: 50, screenY: 500, clientX: 50 })
        firePointer('pointerup', line, { pointerId: 1, screenX: 50, screenY: 500, clientX: 50 })
      })

      // The mark (s2) is the representative, not memberIds[0] (s1) — proves
      // `finishGroupDrag` (SessionTabBar.tsx:297-298) prefers the mark over the first
      // member whenever the mark is itself a member of the dragged group.
      expect(window.octopusAPI.windows.createWithSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's2' })
      )
      expect(window.octopusAPI.sessions.move).not.toHaveBeenCalled()
    })

    it('falls back to the group’s FIRST member when the mark is a lone tab outside the group', async () => {
      seed({
        sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
        groups: [group('g1', rowSplit('s1', 's2'), 0)]
      })
      setTabRects({ s1: rectAt(0), s2: rectAt(1), s3: rectAt(2) })
      useStore.getState().setActiveSession('t1', 's3') // mark = s3, lone, outside g1
      render(<SessionTabBar taskId="t1" />)

      // Grab the SECOND member's line (s2), not the first (s1) — proves the fallback
      // picks `memberIds[0]` specifically, not whichever tab's line initiated the drag.
      const line = getGroupLine('s2')
      await act(async () => {
        firePointer('pointerdown', line, { pointerId: 1, screenX: 150, screenY: 15, clientX: 150 })
        firePointer('pointermove', line, { pointerId: 1, screenX: 150, screenY: 500, clientX: 150 })
        firePointer('pointerup', line, { pointerId: 1, screenX: 150, screenY: 500, clientX: 150 })
      })

      expect(window.octopusAPI.windows.createWithSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1' })
      )
    })

    it('calls sessions.move with the resolved window when dropped on ANOTHER window', async () => {
      seed({
        sessions: [session('s1'), session('s2', { order: 1 })],
        groups: [group('g1', rowSplit('s1', 's2'), 0)]
      })
      setTabRects({ s1: rectAt(0), s2: rectAt(1) })
      // seed()'s default mark is s1 (sessions[0]), a member of g1.
      vi.mocked(window.octopusAPI.windows.windowAtPoint).mockResolvedValueOnce('win-2')
      render(<SessionTabBar taskId="t1" />)

      const line = getGroupLine('s1')
      await act(async () => {
        firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
        firePointer('pointermove', line, { pointerId: 1, screenX: 50, screenY: 500, clientX: 50 })
        firePointer('pointerup', line, { pointerId: 1, screenX: 50, screenY: 500, clientX: 50 })
      })

      expect(window.octopusAPI.sessions.move).toHaveBeenCalledWith({
        sessionId: 's1',
        targetWindowId: 'win-2'
      })
      expect(window.octopusAPI.windows.createWithSession).not.toHaveBeenCalled()
    })

    it('sends no command when the drop resolves back to THIS window', async () => {
      seed({
        sessions: [session('s1'), session('s2', { order: 1 })],
        groups: [group('g1', rowSplit('s1', 's2'), 0)]
      })
      setTabRects({ s1: rectAt(0), s2: rectAt(1) })
      vi.mocked(window.octopusAPI.windows.windowAtPoint).mockResolvedValueOnce('main')
      render(<SessionTabBar taskId="t1" />)

      const line = getGroupLine('s1')
      await act(async () => {
        firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
        firePointer('pointermove', line, { pointerId: 1, screenX: 50, screenY: 500, clientX: 50 })
        firePointer('pointerup', line, { pointerId: 1, screenX: 50, screenY: 500, clientX: 50 })
      })

      expect(window.octopusAPI.sessions.move).not.toHaveBeenCalled()
      expect(window.octopusAPI.windows.createWithSession).not.toHaveBeenCalled()
    })
  })

  describe('group-line drag: stuck-drag / silent capture-drop defenses (SessionTabBar.tsx:388-423)', () => {
    it('a window-level pointerup after a past-threshold move ends the drag correctly, and a later duplicate on the (still-attached) line is a no-op', () => {
      seed({
        sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
        groups: [group('g1', rowSplit('s1', 's2'), 0)]
      })
      setTabRects({ s1: rectAt(0), s2: rectAt(1), s3: rectAt(2) })
      render(<SessionTabBar taskId="t1" />)

      const line = getGroupLine('s1')
      firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
      firePointer('pointermove', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })
      // Fired on window, not the (possibly capture-dropped) line element — models
      // Electron 33 silently dropping pointer capture when the capturing node is
      // recreated mid-gesture.
      firePointer('pointerup', window as unknown as Element, {
        pointerId: 1,
        screenX: 250,
        screenY: 15,
        clientX: 250
      })

      // moveList = ['s1','s3'] (s2 excluded); arrayMove(0,1) -> ['s3','s1']; indexOf = 1.
      expect(window.octopusAPI.groups.reorder).toHaveBeenCalledTimes(1)
      expect(window.octopusAPI.groups.reorder).toHaveBeenCalledWith({
        taskId: 't1',
        groupId: 'g1',
        toIndex: 1
      })

      // The same native event also bubbling to the still-attached element listener
      // must be a no-op — not a second finish (the `ended` guard, SessionTabBar.tsx:362-363).
      firePointer('pointerup', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })
      expect(window.octopusAPI.groups.reorder).toHaveBeenCalledTimes(1)
    })

    it('pointercancel/lostpointercapture end the drag with NO command, un-dim the tabs, and any later pointer event is a no-op', () => {
      seed({
        sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
        groups: [group('g1', rowSplit('s1', 's2'), 0)]
      })
      setTabRects({ s1: rectAt(0), s2: rectAt(1), s3: rectAt(2) })
      render(<SessionTabBar taskId="t1" />)

      const line = getGroupLine('s1')
      firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
      firePointer('pointermove', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })
      expect(getTab('s1').style.opacity).toBe('0.5')

      firePointer('pointercancel', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })

      expect(window.octopusAPI.groups.reorder).not.toHaveBeenCalled()
      expect(window.octopusAPI.sessions.move).not.toHaveBeenCalled()
      expect(window.octopusAPI.windows.createWithSession).not.toHaveBeenCalled()
      expect(getTab('s1').style.opacity).toBe('1')

      // A later, separate pointerup — on the line OR on window — after the drag already
      // ended must do nothing (proves the end-of-drag cleanup actually removed every
      // listener it attached, SessionTabBar.tsx:365-370).
      firePointer('pointerup', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })
      firePointer('pointerup', window as unknown as Element, {
        pointerId: 1,
        screenX: 250,
        screenY: 15,
        clientX: 250
      })
      expect(window.octopusAPI.groups.reorder).not.toHaveBeenCalled()

      // A second gesture with a `lostpointercapture` instead of `pointercancel` behaves
      // identically.
      firePointer('pointerdown', getGroupLine('s1'), {
        pointerId: 2,
        screenX: 50,
        screenY: 15,
        clientX: 50
      })
      firePointer('pointermove', getGroupLine('s1'), {
        pointerId: 2,
        screenX: 250,
        screenY: 15,
        clientX: 250
      })
      expect(getTab('s1').style.opacity).toBe('0.5')
      firePointer('lostpointercapture', getGroupLine('s1'), {
        pointerId: 2,
        screenX: 250,
        screenY: 15,
        clientX: 250
      })
      expect(window.octopusAPI.groups.reorder).not.toHaveBeenCalled()
      expect(getTab('s1').style.opacity).toBe('1')
    })

    it('ignores a window-level pointer event for a DIFFERENT pointerId mid-drag', () => {
      seed({
        sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
        groups: [group('g1', rowSplit('s1', 's2'), 0)]
      })
      setTabRects({ s1: rectAt(0), s2: rectAt(1), s3: rectAt(2) })
      render(<SessionTabBar taskId="t1" />)

      const line = getGroupLine('s1')
      firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
      firePointer('pointermove', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })

      // A second, concurrent pointer's window-level pointerup must not end THIS drag.
      firePointer('pointerup', window as unknown as Element, {
        pointerId: 2,
        screenX: 250,
        screenY: 15,
        clientX: 250
      })
      expect(window.octopusAPI.groups.reorder).not.toHaveBeenCalled()
      expect(getTab('s1').style.opacity).toBe('0.5') // still mid-drag, not ended

      // The REAL pointer's own window-level pointerup still finishes it correctly.
      firePointer('pointerup', window as unknown as Element, {
        pointerId: 1,
        screenX: 250,
        screenY: 15,
        clientX: 250
      })
      expect(window.octopusAPI.groups.reorder).toHaveBeenCalledTimes(1)
    })

    it('a groupsChanged that dissolves the dragged group mid-drag ends the drag with no command and un-dims the tabs', () => {
      seed({
        sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
        groups: [group('g1', rowSplit('s1', 's2'), 0)]
      })
      setTabRects({ s1: rectAt(0), s2: rectAt(1), s3: rectAt(2) })
      render(<SessionTabBar taskId="t1" />)

      const line = getGroupLine('s1')
      firePointer('pointerdown', line, { pointerId: 1, screenX: 50, screenY: 15, clientX: 50 })
      firePointer('pointermove', line, { pointerId: 1, screenX: 250, screenY: 15, clientX: 250 })
      expect(getTab('s1').style.opacity).toBe('0.5')

      // The group dissolves out from under the drag (e.g. a concurrent ungroup/leave
      // landing from another window) — no pointer event follows at all.
      act(() => {
        useStore.getState().applyEvent({ type: 'groupsChanged', taskId: 't1', groups: [] })
      })

      expect(getTab('s1').style.opacity).toBe('1')

      // No further pointer event can resurrect/finish the now-torn-down drag.
      firePointer('pointerup', window as unknown as Element, {
        pointerId: 1,
        screenX: 250,
        screenY: 15,
        clientX: 250
      })
      expect(window.octopusAPI.groups.reorder).not.toHaveBeenCalled()
      expect(window.octopusAPI.sessions.move).not.toHaveBeenCalled()
      expect(window.octopusAPI.windows.createWithSession).not.toHaveBeenCalled()
    })
  })

  it('disables both split items when this bar is not showing the active task', () => {
    seed({ sessions: [session('s1'), session('s2', { order: 1 })] })
    useStore.setState({ activeTaskId: 'other' })
    render(<SessionTabBar taskId="t1" />)
    openTabMenu('s2')
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeDisabled()
  })

  it("disables both split items for a session already a member of the mark's group", () => {
    seed({
      sessions: [session('s1'), session('s2', { order: 1 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    useStore.getState().setActiveSession('t1', 's1')
    render(<SessionTabBar taskId="t1" />)
    openTabMenu('s2')
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeDisabled()
  })

  it('disables both split items for the sole (unsplit) focused tab itself', () => {
    seed({ sessions: [session('s1')] })
    render(<SessionTabBar taskId="t1" />)
    openTabMenu('s1')
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeDisabled()
  })

  it('disables both split items when the focused (marked) pane measures too small to halve', () => {
    seed({ sessions: [session('s1'), session('s2', { order: 1 })] })
    // s1 is the mark; register a measurer too small to halve either way — real `canSplit`
    // math decides disablement, not a stub boolean.
    registerPaneMetrics('s1', () => ({
      widthPx: 100,
      heightPx: 100,
      cellWidthPx: 10,
      cellHeightPx: 10
    }))
    render(<SessionTabBar taskId="t1" />)
    openTabMenu('s2')
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeDisabled()
    unregisterPaneMetrics('s1')
  })

  it('enables both split items when the focused (marked) pane measures large enough to halve', () => {
    seed({ sessions: [session('s1'), session('s2', { order: 1 })] })
    registerPaneMetrics('s1', () => ({
      widthPx: 2000,
      heightPx: 1000,
      cellWidthPx: 8,
      cellHeightPx: 16
    }))
    render(<SessionTabBar taskId="t1" />)
    openTabMenu('s2')
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeEnabled()
    unregisterPaneMetrics('s1')
  })

  it('a wide-but-short pane enables Split right while disabling Split down (the two canSplit directions are independent)', () => {
    seed({ sessions: [session('s1'), session('s2', { order: 1 })] })
    // Halving WIDTH (row/Split right): (2000/2)/8 = 125 cols >= MIN_PANE_COLS (20);
    // full HEIGHT/16 = 6.25 rows >= MIN_PANE_ROWS (5) -> fits.
    // Halving HEIGHT (col/Split down): full WIDTH/8 = 250 cols >= 20 -> fine, but
    // (100/2)/16 = 3.125 rows < MIN_PANE_ROWS (5) -> does NOT fit. A mutant that
    // collapses the two `canSplit` direction checks into one shared verdict (instead of
    // calling `canSplit(..., 'row')` and `canSplit(..., 'col')` independently,
    // SessionTabBar.tsx's `evaluateSplitMenu`) would make both items agree — this
    // fixture is built so they must disagree.
    registerPaneMetrics('s1', () => ({
      widthPx: 2000,
      heightPx: 100,
      cellWidthPx: 8,
      cellHeightPx: 16
    }))
    render(<SessionTabBar taskId="t1" />)
    openTabMenu('s2')
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeDisabled()
    unregisterPaneMetrics('s1')
  })

  it('"Split right"/"Split down" call groups.join with the mark as anchor', () => {
    seed({ sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })] })
    render(<SessionTabBar taskId="t1" />) // s1 is the sole, unsplit mark
    openTabMenu('s2')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }))
    expect(window.octopusAPI.groups.join).toHaveBeenCalledWith({
      sessionId: 's2',
      anchorSessionId: 's1',
      dir: 'row'
    })

    openTabMenu('s3')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split down' }))
    expect(window.octopusAPI.groups.join).toHaveBeenCalledWith({
      sessionId: 's3',
      anchorSessionId: 's1',
      dir: 'col'
    })
  })

  it('a failed groups.join ack surfaces an error toast', async () => {
    installStubBridge({ ack: () => ({ ok: false, error: 'Pane too small' }) })
    seed({ sessions: [session('s1'), session('s2', { order: 1 })] })
    render(<SessionTabBar taskId="t1" />)
    openTabMenu('s2')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }))
    })
    const toasts = useStore.getState().toasts
    expect(toasts.at(-1)?.kind).toBe('error')
    expect(toasts.at(-1)?.message).toBe('Pane too small')
  })

  it('"Remove from group" only appears for a member tab, and calls groups.leave', () => {
    seed({
      sessions: [session('s1'), session('s2', { order: 1 }), session('s3', { order: 2 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    render(<SessionTabBar taskId="t1" />)

    openTabMenu('s3') // lone tab: no such item
    expect(screen.queryByRole('menuitem', { name: 'Remove from group' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })

    openTabMenu('s2')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from group' }))
    expect(window.octopusAPI.groups.leave).toHaveBeenCalledWith({ sessionId: 's2' })
  })

  it('a failed groups.leave ack surfaces an error toast', async () => {
    installStubBridge({ ack: () => ({ ok: false, error: 'Cannot leave group' }) })
    seed({
      sessions: [session('s1'), session('s2', { order: 1 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    render(<SessionTabBar taskId="t1" />)
    openTabMenu('s2')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from group' }))
    })
    const toasts = useStore.getState().toasts
    expect(toasts.at(-1)?.kind).toBe('error')
    expect(toasts.at(-1)?.message).toBe('Cannot leave group')
  })

  it('a failed groups.ungroup ack surfaces an error toast', async () => {
    installStubBridge({ ack: () => ({ ok: false, error: 'Cannot ungroup' }) })
    seed({
      sessions: [session('s1'), session('s2', { order: 1 })],
      groups: [group('g1', rowSplit('s1', 's2'), 0)]
    })
    render(<SessionTabBar taskId="t1" />)
    fireEvent.contextMenu(getGroupLine('s1'))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Ungroup' }))
    })
    const toasts = useStore.getState().toasts
    expect(toasts.at(-1)?.kind).toBe('error')
    expect(toasts.at(-1)?.message).toBe('Cannot ungroup')
  })

  it('drags a lone tab past another, computing toIndex against the FULL cross-window order (IMP4)', () => {
    // s2 is hosted in another window, so it never renders here, but it still occupies a
    // slot in the task's full order BETWEEN s1 and s3 — the window-filtered list (s1, s3)
    // would compute a different (wrong) index than the real `fullOrder` does.
    seed({
      sessions: [
        session('s2', { order: 0, windowId: 'other' }),
        session('s1', { order: 1 }),
        session('s3', { order: 2 })
      ]
    })
    setTabRects({ s1: rectAt(0), s3: rectAt(1) })
    render(<SessionTabBar taskId="t1" />)

    const s1Tab = getTab('s1')
    firePointer('pointerdown', s1Tab, { pointerId: 1, clientX: 50, clientY: 15 })
    // First move clears the dnd-kit PointerSensor's activation distance (4px); dnd-kit
    // listens for the rest of the gesture on `document`, not the (possibly reordered) tab.
    firePointer('pointermove', document, { pointerId: 1, clientX: 60, clientY: 15 })
    // Second move: now activated, this is the position collision detection acts on —
    // past s3's center, so `over` resolves to s3.
    firePointer('pointermove', document, { pointerId: 1, clientX: 210, clientY: 15 })
    firePointer('pointerup', document, { pointerId: 1, clientX: 210, clientY: 15 })

    // fullOrder = [s2, s1, s3]; from = 1 (s1), to = 2 (s3);
    // arrayMove(['s2','s1','s3'], 1, 2) = ['s2','s3','s1']; indexOf('s1') = 2 — NOT 1, which
    // is what computing against the window-filtered [s1, s3] list alone would have given.
    expect(window.octopusAPI.sessions.reorder).toHaveBeenCalledWith({
      taskId: 't1',
      sessionId: 's1',
      toIndex: 2
    })
  })
})
