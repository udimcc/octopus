/**
 * `<SessionPane>` wiring for split panes (DESIGN §5.7): a mousedown anywhere in an
 * unfocused split leaf must move keyboard focus there via `focusPane` — but only
 * when the pane is actually a split leaf (`rect` present) AND not already focused.
 * An unsplit pane, and an already-focused split pane, must never call it (xterm
 * still needs the raw mousedown for text selection / mouse reporting underneath).
 *
 * The session view itself is irrelevant here (xterm needs a canvas jsdom lacks),
 * so `resolveSessionView` is stubbed to a trivial div — this test is only about the
 * wrapping div's `onMouseDownCapture` wiring to the REAL store action.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { SessionPane } from './SessionPane'
import { useStore, initialData } from '../store/store'
import type { SessionDTO } from '../../../shared/dto'
import type { PaneRect } from '../store/split-layout'

// Several tests below replace `focusPane` with a spy via `useStore.setState`. Since
// `beforeEach`'s `setState(initialData())` is a plain object merge (no actions),
// zustand's shallow merge leaves a previously-installed spy in place for the NEXT
// test unless it's explicitly restored — captured once here (the real action, before
// any test touches it) so every test starts from the genuine reducer.
const realFocusPane = useStore.getState().focusPane

vi.mock('../session-views/session-view-factory', () => ({
  resolveSessionView: () => (props: { sessionId: string }) => (
    <div data-testid={`view-${props.sessionId}`} />
  )
}))

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

const RECT: PaneRect = { left: 0, top: 0, width: 50, height: 100 }

describe('<SessionPane> mousedown-to-focus wiring (§5.7)', () => {
  beforeEach(() => {
    useStore.setState({ ...initialData(), focusPane: realFocusPane })
    cleanup()
  })

  afterEach(() => {
    useStore.setState({ focusPane: realFocusPane })
  })

  it('a mousedown in an UNFOCUSED split leaf moves the mark there via focusPane', () => {
    const s1 = session('s1')
    useStore.setState({
      sessions: { s1 },
      tasks: {
        t1: {
          id: 't1',
          name: 'Alpha',
          lifecycle: 'ready',
          state: 'unknown',
          sessionIds: ['s1'],
          position: 0,
          createdAt: 1000
        }
      },
      windowId: 'main',
      // A different session currently holds this window's mark for t1.
      activeSessionByTask: { t1: 'other' }
    })
    const { container } = render(
      <SessionPane session={s1} visible={true} focused={false} rect={RECT} />
    )
    fireEvent.mouseDown(container.firstChild as Element)
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')
  })

  it('a mousedown that moves the mark is NOT consumed — it still reaches the view underneath', () => {
    // DESIGN §5.7: "focuses it without consuming the event" — xterm still needs the
    // raw mousedown for text selection / mouse reporting. `onMouseDownCapture` must
    // call `focusPane` without ever calling `preventDefault`/`stopPropagation`, so a
    // native listener on the view underneath still sees the event, unprevented.
    const s1 = session('s1')
    const focusPane = vi.fn()
    useStore.setState({
      sessions: { s1 },
      windowId: 'main',
      activeSessionByTask: { t1: 'other' },
      focusPane
    })
    render(<SessionPane session={s1} visible={true} focused={false} rect={RECT} />)
    const view = document.querySelector('[data-testid="view-s1"]') as HTMLElement
    const listener = vi.fn()
    view.addEventListener('mousedown', listener)

    // `fireEvent` returns `false` iff some handler called `preventDefault`.
    const notPrevented = fireEvent.mouseDown(view)

    expect(notPrevented).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(focusPane).toHaveBeenCalledWith('s1')
  })

  it('a mousedown in an UNSPLIT pane (no rect) does not call focusPane', () => {
    const s1 = session('s1')
    const focusPane = vi.fn()
    useStore.setState({
      sessions: { s1 },
      windowId: 'main',
      activeSessionByTask: { t1: 'other' },
      focusPane
    })
    const { container } = render(<SessionPane session={s1} visible={true} focused={false} />)
    fireEvent.mouseDown(container.firstChild as Element)
    // A real reducer no-op (mark already 'other' for a session that was never a
    // leaf) can't tell "never called" apart from "called but harmless" — assert
    // directly on the spy instead.
    expect(focusPane).not.toHaveBeenCalled()
  })

  it('a mousedown in an already-FOCUSED split leaf does not call focusPane', () => {
    const s1 = session('s1')
    const focusPane = vi.fn()
    useStore.setState({
      sessions: { s1 },
      windowId: 'main',
      activeSessionByTask: { t1: 's1' },
      focusPane
    })
    const { container } = render(
      <SessionPane session={s1} visible={true} focused={true} rect={RECT} />
    )
    fireEvent.mouseDown(container.firstChild as Element)
    // Asserting on the real reducer's mark can't fail here: focusPane('s1') while
    // s1 is already the mark is a no-op in `withMark` too, so the old assertion
    // passed whether or not `onMouseDownCapture` was even wired up. Spy instead.
    expect(focusPane).not.toHaveBeenCalled()
  })
})
