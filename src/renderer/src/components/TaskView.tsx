/**
 * The workspace for one task: its `SessionTabBar` + the keep-alive pane stack
 * (DESIGN §5.1/§5.3/§5.7). Extracted from the M5 inline `TaskView`; the tab strip
 * is now `SessionTabBar`, each pane is `SessionPane`, and a shown group adds a
 * `SplitDividers` overlay.
 *
 * KEEP-ALIVE IS LOAD-BEARING (§5.3): a hidden task is NOT unmounted — it stays in
 * the DOM at `position:absolute; width/height:0; visibility:hidden` so its
 * terminals keep running, their scrollback survives, and their WebGL contexts are
 * not dropped (which `display:none` would do). Preserve these exact rules.
 *
 * FLAT RENDER RULE IS LOAD-BEARING (§5.3/§5.7): every hosted session renders here
 * as a sibling `<SessionPane key={sessionId}>` in this same `pane-area`, in this
 * same tab order, whether or not its group is shown. Only each pane's `visible` /
 * `focused` / `rect` props change as the mark moves between a lone session and a
 * group, or as groups are joined/left/ungrouped — never the element's parent,
 * type, or key. Wrapping panes in per-group containers would remount
 * `TerminalPane` (destroying the xterm instance) on every such change.
 * `SplitDividers` is a separate sibling rendered AFTER the panes, never between
 * or around them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SessionPane } from './SessionPane'
import { SessionTabBar } from './SessionTabBar'
import { SplitDividers } from './SplitDividers'
import { useStore, activeSessionInWindow, groupOfSession } from '../store/store'
import { toRects, setRatio, type SplitPath } from '../store/split-layout'
import type { SplitNode } from '../../../shared/dto'

export interface TaskViewProps {
  readonly taskId: string
  readonly active: boolean
}

/** A divider drag's local preview (DESIGN §5.7): `tree` for rendering, `baseTree` the
 * committed tree it was derived from — once the store's tree for this group changes
 * identity (the `groupsChanged` from our own `groups.resize` landed), the preview is
 * stale and is dropped. See the comment on `preview` below for why this, not the
 * pointer release, is what clears it.
 */
interface Preview {
  readonly baseTree: SplitNode
  readonly tree: SplitNode
}

export function TaskView({ taskId, active }: TaskViewProps): React.JSX.Element {
  const task = useStore((s) => s.tasks[taskId])
  const sessions = useStore((s) => s.sessions)
  const windowId = useStore((s) => s.windowId)
  // THIS window's marked session (§3.7) — not shared with other windows, so a switch to
  // a session hosted elsewhere leaves this window showing what it had. A grouped mark
  // (§5.7) is also the group's FOCUSED pane; the other leaves are merely visible.
  const activeSessionId = useStore((s) => activeSessionInWindow(s, taskId, s.windowId))
  // The mark's group in THIS task, if any (§5.7, split-groups design). A lone mark (no
  // group, or a group transiently not yet reflected here) draws no split at all.
  const group = useStore((s) =>
    activeSessionId ? groupOfSession(s, taskId, activeSessionId) : undefined
  )
  const committedTree = group?.layout

  // Local resize preview (DESIGN §5.7 "Divider drag"): `SplitDividers` reports path/ratio
  // as the pointer moves; this component is where the preview is rendered, so it owns the
  // state rather than `SplitDividers` holding it and passing a snapshot up each frame.
  const [preview, setPreview] = useState<Preview | undefined>(undefined)
  // Drop the preview once the backend's own tree for this group changes identity — i.e.
  // once the `groups.resize` command's `groupsChanged` has landed, or the ack came back
  // `{ok:false}` (see `handleCommit`). Clearing on the pointer release instead would show
  // the PRE-drag ratio for the round trip's duration (a visible snap-back) before the
  // ack's event arrives; waiting for the real update never snaps.
  useEffect(() => {
    if (preview && preview.baseTree !== committedTree) setPreview(undefined)
  }, [committedTree, preview])
  // Validated AGAIN at render time, not just by the effect above: an effect runs after
  // the render it was scheduled from, so without this check a stale preview (based on a
  // tree that already changed) would flash for one frame before the effect clears it.
  const tree = preview && preview.baseTree === committedTree ? preview.tree : committedTree

  // Read the COMMITTED tree through a ref, never the `committedTree` closure directly:
  // `SplitDividers` binds its `pointermove` listener once, at pointer-down, to the
  // `handlePreview` it was given for the WHOLE gesture. If this callback closed over
  // `committedTree` and that value changed identity mid-drag (another window resized or
  // edited the same group while this one was dragging it), the drag would keep basing
  // its preview on the stale pre-drag tree instead of the new one. The ref always has
  // the latest value; keeping `handlePreview`'s own identity stable (`[]` deps) means
  // `SplitDividers` never needs to re-bind it either.
  const committedTreeRef = useRef(committedTree)
  committedTreeRef.current = committedTree

  const handlePreview = useCallback((path: SplitPath, ratio: number) => {
    const base = committedTreeRef.current
    if (!base) return
    setPreview((prev) => ({
      baseTree: base,
      tree: setRatio(prev && prev.baseTree === base ? prev.tree : base, path, ratio)
    }))
  }, [])
  const handleCommit = useCallback(
    (path: SplitPath, ratio: number) => {
      if (!group) return
      handlePreview(path, ratio)
      void window.octopusAPI.groups
        .resize({ taskId, groupId: group.id, path, ratio })
        .then((ack) => {
          if (!ack.ok) {
            setPreview(undefined)
            useStore.getState().pushToast('error', ack.error ?? 'Failed to resize split')
          }
        })
    },
    [group, taskId, handlePreview]
  )
  const handleCancel = useCallback(() => setPreview(undefined), [])

  const rects = useMemo(() => toRects(tree), [tree])

  // Only this window's sessions render here (V1.5, §5.6): a session moved to another
  // window unmounts its pane so its terminal stops rendering in this one. Derived in
  // the render body from stable slices (not a selector) so the fresh array doesn't
  // defeat zustand's Object.is bail-out.
  const windowSessionIds = task
    ? task.sessionIds.filter((id) => sessions[id]?.windowId === windowId)
    : []
  // The group's leaves actually hosted in THIS window. A multi-event group move (§7) can
  // transiently leave fewer than 2 of them here — that is not a split worth drawing, so
  // the mark falls back to showing alone until the rest of the move's events arrive.
  const hostedGroupLeaves = tree ? windowSessionIds.filter((id) => rects.has(id)) : []
  const showGroup = hostedGroupLeaves.length >= 2

  // Hidden tasks stay mounted but out of layout so their terminals keep running.
  const style: React.CSSProperties = active
    ? {
        position: 'relative',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-app)'
      }
    : { position: 'absolute', width: 0, height: 0, overflow: 'hidden', visibility: 'hidden' }

  if (!task) return <div style={style} />

  return (
    <div style={style}>
      <SessionTabBar taskId={taskId} />
      <div
        className="pane-area"
        style={{ position: 'relative', flex: 1, minHeight: 0, height: '100%' }}
      >
        {windowSessionIds.map((sid) => {
          const s = sessions[sid]
          if (!s) return null
          const rect = showGroup ? rects.get(sid) : undefined
          // Shown group: every one of ITS leaves hosted here is visible (several panes on
          // screen at once); a hosted session not in that group's leaf set is a hidden tab —
          // hidden exactly like today's inactive pane. Lone mark: today's single-pane logic.
          const visible = showGroup
            ? active && rect !== undefined
            : active && sid === activeSessionId
          const focused = showGroup ? visible && sid === activeSessionId : visible
          return (
            <SessionPane key={sid} session={s} visible={visible} focused={focused} rect={rect} />
          )
        })}
        {showGroup && tree && group ? (
          <SplitDividers
            // Keyed by group id (IMP fix): if the mark moves to a DIFFERENT group
            // mid-drag, this forces a remount instead of reusing the same instance —
            // its unmount cleanup tears down the in-flight native pointer-capture
            // gesture (releases capture, drops listeners) rather than letting it run on
            // against handles computed from a group it no longer belongs to.
            key={group.id}
            tree={tree}
            onPreview={handlePreview}
            onCommit={handleCommit}
            onCancel={handleCancel}
          />
        ) : null}
      </div>
    </div>
  )
}
