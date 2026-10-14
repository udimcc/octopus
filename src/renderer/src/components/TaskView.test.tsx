/**
 * `<TaskView>`'s HARD acceptance criterion (DESIGN §5.3/§5.7, split-groups design):
 * joining, leaving, ungrouping, and switching the mark between a group member and a
 * lone tab must NEVER remount or dispose a session's view — only PROPS on the same,
 * flat `<SessionPane key={sessionId}>` elements change. Every hosted session (not
 * just the ones currently on screen) renders throughout.
 *
 * The session view is stubbed with a tiny component that counts its own mount/unmount
 * via `useEffect` per session id, so the test can assert "same instance, zero unmounts"
 * directly against the real `TaskView` → `SessionPane` render tree and the real store
 * (`groupsByTask`/`groupOfSession`/`setActiveSession`/`applyEvent`) — nothing here
 * re-implements their logic. `SplitDividers` itself is mocked (its own drag mechanics
 * are covered by `SplitDividers.test.tsx`): the mock captures the props `TaskView`
 * passes it so this file can call `onPreview`/`onCommit`/`onCancel` directly and assert
 * on `TaskView`'s OWN wiring (the local preview state, the `groups.resize` command, the
 * failed-ack revert+toast) in isolation from the real pointer-gesture plumbing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { TaskView } from './TaskView'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type { SessionDTO, GroupDTO, SplitNode } from '../../../shared/dto'

const h = vi.hoisted(() => ({
  mountCounts: new Map<string, number>(),
  unmountCounts: new Map<string, number>(),
  // Captured from the most recent `<SplitDividers>` render so tests can drive its
  // callback props directly, as the real pointer gesture (tested elsewhere) would.
  dividers: undefined as
    | {
        tree: SplitNode
        onPreview: (path: readonly ('a' | 'b')[], ratio: number) => void
        onCommit: (path: readonly ('a' | 'b')[], ratio: number) => void
        onCancel: () => void
      }
    | undefined,
  // Counts `<SplitDividers>`'s OWN mount/unmount (distinct from the session panes'
  // above) so a test can prove the `key={group.id}` switch (TaskView.tsx:173) actually
  // remounts it when the mark moves to a DIFFERENT group, rather than reusing the same
  // instance with updated props.
  dividersMountCount: 0,
  dividersUnmountCount: 0
}))

vi.mock('../session-views/session-view-factory', async () => {
  const { useEffect } = await import('react')
  function FakeView(props: {
    sessionId: string
    visible: boolean
    focused: boolean
  }): React.JSX.Element {
    useEffect(() => {
      h.mountCounts.set(props.sessionId, (h.mountCounts.get(props.sessionId) ?? 0) + 1)
      return () => {
        h.unmountCounts.set(props.sessionId, (h.unmountCounts.get(props.sessionId) ?? 0) + 1)
      }
      // Mount/unmount only — never on a prop change (that's the whole point).
    }, [])
    return (
      <div
        data-testid={`pane-${props.sessionId}`}
        data-visible={props.visible}
        data-focused={props.focused}
      />
    )
  }
  return { resolveSessionView: () => FakeView }
})

// Stubbed to isolate TaskView's OWN preview/commit wiring from SplitDividers' real
// pointer-capture mechanics (covered by SplitDividers.test.tsx).
vi.mock('./SplitDividers', async () => {
  const { useEffect, useRef } = await import('react')
  function FakeDividers(props: {
    tree: SplitNode
    onPreview: (path: readonly ('a' | 'b')[], ratio: number) => void
    onCommit: (path: readonly ('a' | 'b')[], ratio: number) => void
    onCancel: () => void
  }): React.JSX.Element {
    h.dividers = props
    // Track THIS instance's latest props in a ref — not the one the mount effect
    // closed over (frozen at first render, deps `[]`) — so the unmount cleanup below
    // can tell whether it is still the CURRENT instance before clearing `h.dividers`.
    // Without this, when the mark moves to a DIFFERENT group (a `key` change,
    // TaskView.tsx:173), React mounts the NEW instance (which sets `h.dividers` to its
    // own props during render) before running the OLD instance's passive-effect
    // cleanup — an unconditional clear there would clobber the NEW instance's props
    // back to `undefined` right after it was set.
    const propsRef = useRef(props)
    propsRef.current = props
    useEffect(() => {
      h.dividersMountCount++
      return () => {
        h.dividersUnmountCount++
        if (h.dividers === propsRef.current) h.dividers = undefined
      }
    }, [])
    return <div data-testid="dividers" />
  }
  return { SplitDividers: FakeDividers }
})

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

function leaf(sessionId: string): SplitNode {
  return { kind: 'leaf', sessionId }
}

function rowSplit(a: SplitNode, b: SplitNode, ratio = 0.5): SplitNode {
  return { kind: 'split', dir: 'row', ratio, a, b }
}

function group(id: string, layout: SplitNode, colorIndex = 0): GroupDTO {
  return { id, layout, colorIndex }
}

/** The `FakeView` itself — carries the `visible`/`focused` props it was passed. */
function paneView(sessionId: string): HTMLElement {
  const view = document.querySelector(`[data-testid="pane-${sessionId}"]`)
  if (!view) throw new Error(`no pane rendered for ${sessionId}`)
  return view as HTMLElement
}

/** The style-bearing div `SessionPane` renders around a given session's `FakeView`. */
function paneWrapper(sessionId: string): HTMLElement {
  const wrapper = paneView(sessionId).parentElement
  if (!wrapper) throw new Error(`no pane wrapper rendered for ${sessionId}`)
  return wrapper
}

describe('<TaskView> never remounts a session pane across group restructuring (§5.3/§5.7)', () => {
  beforeEach(() => {
    h.mountCounts.clear()
    h.unmountCounts.clear()
    h.dividers = undefined
    h.dividersMountCount = 0
    h.dividersUnmountCount = 0
    cleanup()
    installStubBridge()
    useStore.setState({
      ...initialData(),
      windowId: 'main',
      activeTaskId: 't1',
      sessions: {
        s1: session('s1', { order: 0 }),
        s2: session('s2', { order: 1 }),
        s3: session('s3', { order: 2 })
      },
      tasks: {
        t1: {
          id: 't1',
          name: 'Alpha',
          lifecycle: 'ready',
          state: 'unknown',
          sessionIds: ['s1', 's2', 's3'],
          position: 0,
          createdAt: 1000
        }
      },
      taskOrder: ['t1'],
      groupsByTask: { t1: [] },
      // s1 is this window's mark.
      activeSessionByTask: { t1: 's1' }
    })
  })

  function expectNoRemounts(): void {
    for (const id of ['s1', 's2', 's3']) {
      expect(h.mountCounts.get(id)).toBe(1)
      expect(h.unmountCounts.get(id) ?? 0).toBe(0)
    }
  }

  it('mounts every hosted session once, up front; lone mark shows alone, full-size', () => {
    render(<TaskView taskId="t1" active={true} />)
    expectNoRemounts()
    expect(paneView('s1').getAttribute('data-visible')).toBe('true')
    expect(paneView('s1').getAttribute('data-focused')).toBe('true')
    expect(paneView('s2').getAttribute('data-visible')).toBe('false')
    expect(paneView('s3').getAttribute('data-visible')).toBe('false')
    // Lone path: `rect` is absent → `inset:0`, no `left`/`top`/`width`/`height`.
    expect(paneWrapper('s1').style.left).toBe('')
    expect(paneWrapper('s1').style.position).toBe('absolute')
    // No group shown → no dividers.
    expect(h.dividers).toBeUndefined()
  })

  it('join: a groupsChanged forming s1+s2 shows both with rects; the mark alone is focused — no remount', () => {
    // Start non-contiguous (s1, s3, s2) — joining s1+s2 into a group requires the
    // backend to also reorder tabs so the group is contiguous (DESIGN §5.7); it
    // publishes `sessionReordered` alongside `groupsChanged` for a join (membership
    // changes order), never `groupsChanged` alone.
    useStore.setState({
      tasks: {
        t1: {
          ...useStore.getState().tasks.t1,
          sessionIds: ['s1', 's3', 's2']
        }
      }
    })
    render(<TaskView taskId="t1" active={true} />)

    act(() => {
      useStore.getState().applyEvent({
        type: 'sessionReordered',
        taskId: 't1',
        orderedSessionIds: ['s1', 's2', 's3']
      })
      useStore.getState().applyEvent({
        type: 'groupsChanged',
        taskId: 't1',
        groups: [group('g1', rowSplit(leaf('s1'), leaf('s2')))]
      })
    })

    expectNoRemounts()
    expect(useStore.getState().tasks.t1.sessionIds).toEqual(['s1', 's2', 's3'])
    expect(paneView('s1').getAttribute('data-visible')).toBe('true')
    expect(paneView('s1').getAttribute('data-focused')).toBe('true')
    expect(paneView('s2').getAttribute('data-visible')).toBe('true')
    expect(paneView('s2').getAttribute('data-focused')).toBe('false')
    // s3 isn't in the tree — still a hidden tab.
    expect(paneView('s3').getAttribute('data-visible')).toBe('false')
    // Both leaves got a percentage rect; only the mark (s1) carries the focus outline.
    expect(paneWrapper('s1').style.left).not.toBe('')
    expect(paneWrapper('s2').style.left).not.toBe('')
    expect(paneWrapper('s1').style.outline).not.toBe('')
    expect(paneWrapper('s2').style.outline).toBe('')
    expect(h.dividers?.tree).toEqual(rowSplit(leaf('s1'), leaf('s2')))
  })

  it('join: adding a third member to an existing shown group updates rects for all three — no remount', () => {
    useStore.setState({ groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] } })
    render(<TaskView taskId="t1" active={true} />)
    const s1WidthBefore = paneWrapper('s1').style.width

    act(() => {
      useStore.getState().applyEvent({
        type: 'groupsChanged',
        taskId: 't1',
        groups: [group('g1', rowSplit(rowSplit(leaf('s1'), leaf('s2')), leaf('s3')))]
      })
    })

    expectNoRemounts()
    expect(paneView('s3').getAttribute('data-visible')).toBe('true')
    expect(paneView('s3').getAttribute('data-focused')).toBe('false')
    // s1's rect changed shape (now nested inside the outer split's left half) —
    // same element, new props.
    expect(paneWrapper('s1').style.width).not.toBe(s1WidthBefore)
  })

  it('leave: a groupsChanged dropping a member back to lone makes it a hidden tab — no remount', () => {
    useStore.setState({ groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] } })
    render(<TaskView taskId="t1" active={true} />)

    // s2 left; a 2-member group dissolves entirely on one leaving (DESIGN §5.7). The
    // backend publishes `sessionReordered` alongside `groupsChanged` for a leave too
    // (uniform combined-event shape, same as join) — here the order happens to stay
    // the same (the departing member was already tab-adjacent), but both events still
    // land together, as the real backend would send them.
    act(() => {
      useStore.getState().applyEvent({
        type: 'sessionReordered',
        taskId: 't1',
        orderedSessionIds: ['s1', 's2', 's3']
      })
      useStore.getState().applyEvent({ type: 'groupsChanged', taskId: 't1', groups: [] })
    })

    expectNoRemounts()
    expect(paneView('s1').getAttribute('data-visible')).toBe('true')
    expect(paneView('s1').getAttribute('data-focused')).toBe('true')
    expect(paneView('s2').getAttribute('data-visible')).toBe('false')
    expect(paneWrapper('s1').style.left).toBe('')
    expect(h.dividers).toBeUndefined()
  })

  it('ungroup: dissolving a 3-member group drops every member to lone — mark shows alone, no remount', () => {
    useStore.setState({
      groupsByTask: { t1: [group('g1', rowSplit(rowSplit(leaf('s1'), leaf('s2')), leaf('s3')))] }
    })
    render(<TaskView taskId="t1" active={true} />)

    act(() => {
      useStore.getState().applyEvent({ type: 'groupsChanged', taskId: 't1', groups: [] })
    })

    expectNoRemounts()
    expect(paneView('s1').getAttribute('data-visible')).toBe('true')
    expect(paneView('s1').getAttribute('data-focused')).toBe('true')
    expect(paneView('s2').getAttribute('data-visible')).toBe('false')
    expect(paneView('s3').getAttribute('data-visible')).toBe('false')
    expect(h.dividers).toBeUndefined()
  })

  it('mark moves from a group member to a lone tab: the group stops drawing, the lone tab shows alone — no remount', () => {
    useStore.setState({ groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] } })
    render(<TaskView taskId="t1" active={true} />)
    expect(h.dividers).not.toBeUndefined()

    // s3 is a lone hidden tab, outside the group — marking it must swap the WHOLE
    // display from "group" to "lone, s3 alone", not just move focus within the tree.
    act(() => {
      useStore.getState().setActiveSession('t1', 's3')
    })

    expectNoRemounts()
    expect(paneView('s3').getAttribute('data-visible')).toBe('true')
    expect(paneView('s3').getAttribute('data-focused')).toBe('true')
    expect(paneView('s1').getAttribute('data-visible')).toBe('false')
    expect(paneView('s2').getAttribute('data-visible')).toBe('false')
    expect(paneWrapper('s3').style.left).toBe('')
    expect(h.dividers).toBeUndefined()
  })

  it('mark moves back from a lone tab into an existing group: the group redraws — no remount throughout', () => {
    useStore.setState({
      groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] },
      activeSessionByTask: { t1: 's3' }
    })
    render(<TaskView taskId="t1" active={true} />)
    expect(h.dividers).toBeUndefined() // s3 is lone — nothing shown as a group yet.

    act(() => {
      useStore.getState().setActiveSession('t1', 's1') // s1 is a member of g1
    })

    expectNoRemounts()
    expect(h.dividers).not.toBeUndefined()
    expect(paneView('s1').getAttribute('data-visible')).toBe('true')
    expect(paneView('s1').getAttribute('data-focused')).toBe('true')
    expect(paneView('s2').getAttribute('data-visible')).toBe('true')
    expect(paneView('s2').getAttribute('data-focused')).toBe('false')
    expect(paneView('s3').getAttribute('data-visible')).toBe('false')
  })

  it('close a sibling: closing a non-marked group member unmounts only that pane; the mark is untouched', () => {
    useStore.setState({ groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] } })
    render(<TaskView taskId="t1" active={true} />)

    act(() => {
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's2' })
    })

    expect(h.mountCounts.get('s1')).toBe(1)
    expect(h.unmountCounts.get('s1') ?? 0).toBe(0)
    expect(h.mountCounts.get('s2')).toBe(1)
    expect(h.unmountCounts.get('s2')).toBe(1) // actually removed, not merely hidden
    expect(h.mountCounts.get('s3')).toBe(1)
    expect(h.unmountCounts.get('s3') ?? 0).toBe(0)
    expect(useStore.getState().activeSessionByTask.t1).toBe('s1')

    // The group dissolves separately via its own trailing groupsChanged (DESIGN §5.7
    // comment, store.ts `removeSession`) — once it lands, s1 shows alone.
    act(() => {
      useStore.getState().applyEvent({ type: 'groupsChanged', taskId: 't1', groups: [] })
    })
    expect(paneView('s1').getAttribute('data-visible')).toBe('true')
    expect(paneView('s1').getAttribute('data-focused')).toBe('true')
    expect(paneWrapper('s1').style.left).toBe('')
  })

  it('a sibling close that drops hosted leaves below 2 falls back to the mark alone, before the trailing groupsChanged lands', () => {
    useStore.setState({ groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] } })
    render(<TaskView taskId="t1" active={true} />)
    expect(h.dividers).not.toBeUndefined()

    // Only `sessionClosed` has landed so far — the group's OWN trailing `groupsChanged`
    // dissolving it (DESIGN §5.7 comment, store.ts `removeSession`) is still in flight.
    // `group.layout` still names s2, but s2 is no longer hosted here at all (removed by
    // `sessionClosed`), so `hostedGroupLeaves` (TaskView.tsx:127) drops to just s1 —
    // below the 2-leaf threshold (`showGroup`, TaskView.tsx:128) — and the view must
    // fall back to lone-mark display rather than keep drawing a one-leaf "group".
    act(() => {
      useStore.getState().applyEvent({ type: 'sessionClosed', taskId: 't1', sessionId: 's2' })
    })

    expect(h.dividers).toBeUndefined()
    expect(paneView('s1').getAttribute('data-visible')).toBe('true')
    expect(paneView('s1').getAttribute('data-focused')).toBe('true')
    expect(paneWrapper('s1').style.left).toBe('')
  })

  it('mark moves from one group to a DIFFERENT group: SplitDividers remounts for the new group — no pane remount', () => {
    useStore.setState({
      sessions: {
        s1: session('s1', { order: 0 }),
        s2: session('s2', { order: 1 }),
        s3: session('s3', { order: 2 }),
        s4: session('s4', { order: 3 })
      },
      tasks: {
        t1: {
          id: 't1',
          name: 'Alpha',
          lifecycle: 'ready',
          state: 'unknown',
          sessionIds: ['s1', 's2', 's3', 's4'],
          position: 0,
          createdAt: 1000
        }
      },
      groupsByTask: {
        t1: [
          group('g1', rowSplit(leaf('s1'), leaf('s2'))),
          group('g2', rowSplit(leaf('s3'), leaf('s4')))
        ]
      },
      activeSessionByTask: { t1: 's1' }
    })
    render(<TaskView taskId="t1" active={true} />)
    expect(h.dividers?.tree).toEqual(rowSplit(leaf('s1'), leaf('s2')))
    expect(h.dividersMountCount).toBe(1)

    // s3 is a member of a DIFFERENT group (g2) — switching the mark to it must swap
    // which group is drawn entirely, not just update the same `<SplitDividers>`
    // instance's props.
    act(() => {
      useStore.getState().setActiveSession('t1', 's3')
    })

    for (const id of ['s1', 's2', 's3', 's4']) {
      expect(h.mountCounts.get(id)).toBe(1)
      expect(h.unmountCounts.get(id) ?? 0).toBe(0)
    }
    // `SplitDividers` (keyed by group id, TaskView.tsx:173) DOES remount — the old g1
    // instance unmounts and a fresh g2 instance mounts; without `key={group.id}` this
    // would stay the SAME instance (counts would still read 1/0).
    expect(h.dividersMountCount).toBe(2)
    expect(h.dividersUnmountCount).toBe(1)
    // And it reflects g2's OWN tree — proves the harness's unmount cleanup didn't
    // clobber the new instance's just-captured props back to `undefined`.
    expect(h.dividers?.tree).toEqual(rowSplit(leaf('s3'), leaf('s4')))
  })

  it('an exited group member stays rendered in its pane — no remount on a lifecycle change', () => {
    useStore.setState({ groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] } })
    render(<TaskView taskId="t1" active={true} />)
    expect(h.mountCounts.get('s2')).toBe(1)

    act(() => {
      useStore
        .getState()
        .applyEvent({ type: 'sessionExited', taskId: 't1', sessionId: 's2', exitCode: 0 })
    })

    expectNoRemounts()
    expect(useStore.getState().sessions.s2.lifecycle).toBe('exited')
    // Still a shown, hosted group leaf — same pane, same instance, still visible.
    expect(paneView('s2').getAttribute('data-visible')).toBe('true')
    expect(h.dividers).not.toBeUndefined()
  })

  it('a task switch (active toggled off then on) hides then reveals every pane without any remount', () => {
    useStore.setState({ groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] } })
    const { rerender } = render(<TaskView taskId="t1" active={true} />)

    rerender(<TaskView taskId="t1" active={false} />)
    expectNoRemounts()
    expect(paneView('s1').getAttribute('data-visible')).toBe('false')
    expect(paneView('s2').getAttribute('data-visible')).toBe('false')
    expect(paneView('s3').getAttribute('data-visible')).toBe('false')
    // `focused` is `visible && sid === activeSessionId` — while inactive, visible is
    // forced false for every pane, so the mark (s1) must report focused=false too.
    expect(paneView('s1').getAttribute('data-focused')).toBe('false')

    rerender(<TaskView taskId="t1" active={true} />)
    expectNoRemounts()
    expect(paneView('s1').getAttribute('data-visible')).toBe('true')
    expect(paneView('s2').getAttribute('data-visible')).toBe('true')
    expect(paneView('s3').getAttribute('data-visible')).toBe('false')
    expect(paneView('s1').getAttribute('data-focused')).toBe('true')
    expect(paneView('s2').getAttribute('data-focused')).toBe('false')
  })

  describe('divider preview/commit wiring (DESIGN §5.7 "Divider drag")', () => {
    beforeEach(() => {
      useStore.setState({ groupsByTask: { t1: [group('g1', rowSplit(leaf('s1'), leaf('s2')))] } })
    })

    it('onPreview updates the rendered rects locally without touching the store — no remount', () => {
      render(<TaskView taskId="t1" active={true} />)
      const widthBefore = paneWrapper('s1').style.width

      act(() => {
        h.dividers?.onPreview([], 0.75)
      })

      expectNoRemounts()
      expect(paneWrapper('s1').style.width).not.toBe(widthBefore)
      expect(h.dividers?.tree).toEqual(rowSplit(leaf('s1'), leaf('s2'), 0.75))
      // The backend's own copy is untouched by a mere preview.
      expect(useStore.getState().groupsByTask.t1?.[0]?.layout).toEqual(
        rowSplit(leaf('s1'), leaf('s2'))
      )
    })

    it('onCommit sends groups.resize with the group id/path/ratio; the preview sticks until the ack event lands', async () => {
      const bridge = installStubBridge()
      render(<TaskView taskId="t1" active={true} />)

      await act(async () => {
        h.dividers?.onCommit([], 0.8)
      })

      expect(bridge.api.groups.resize).toHaveBeenCalledWith({
        taskId: 't1',
        groupId: 'g1',
        path: [],
        ratio: 0.8
      })
      // The LOCAL optimistic preview sticks at the dragged ratio until the backend's
      // own event lands — not yet the authoritative value.
      expect(h.dividers?.tree).toEqual(rowSplit(leaf('s1'), leaf('s2'), 0.8))

      // The backend's ack lands a DIFFERENT ratio (0.6) than the one dragged (0.8) —
      // e.g. clamped, or raced by another window's own resize. The rendered tree must
      // follow the BACKEND's value once it lands, not keep showing the stale local
      // preview. This catches a mutant where TaskView's `preview`/`committedTree`
      // reconciliation (TaskView.tsx:72 and :77) is dropped and the preview is kept
      // forever once set, regardless of what the authoritative event says.
      act(() => {
        useStore.getState().applyEvent({
          type: 'groupsChanged',
          taskId: 't1',
          groups: [group('g1', rowSplit(leaf('s1'), leaf('s2'), 0.6))]
        })
      })
      expectNoRemounts()
      expect(h.dividers?.tree).toEqual(rowSplit(leaf('s1'), leaf('s2'), 0.6))
    })

    it('a failed resize ack reverts the preview and pushes an error toast', async () => {
      installStubBridge({ ack: () => ({ ok: false, error: 'Pane too small' }) })
      render(<TaskView taskId="t1" active={true} />)

      await act(async () => {
        h.dividers?.onCommit([], 0.8)
      })

      // Reverted to the still-committed (pre-drag) tree.
      expect(h.dividers?.tree).toEqual(rowSplit(leaf('s1'), leaf('s2')))
      expectNoRemounts()
      const toasts = useStore.getState().toasts
      expect(toasts.at(-1)?.kind).toBe('error')
      expect(toasts.at(-1)?.message).toBe('Pane too small')
    })

    it('onCancel drops the preview without sending any command', () => {
      const bridge = installStubBridge()
      render(<TaskView taskId="t1" active={true} />)

      act(() => {
        h.dividers?.onPreview([], 0.75)
      })
      act(() => {
        h.dividers?.onCancel()
      })

      expect(h.dividers?.tree).toEqual(rowSplit(leaf('s1'), leaf('s2')))
      expect(bridge.api.groups.resize).not.toHaveBeenCalled()
      expectNoRemounts()
    })
  })
})
