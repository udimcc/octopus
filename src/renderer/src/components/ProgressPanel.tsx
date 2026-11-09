/**
 * The left "Progress" panel (DESIGN §5.1; PRD §Progress Window). It owns:
 *  - `PanelHeader`: the app title + **New Task**, **Delete Task** (disabled when no
 *    active task), and a gear that opens **Settings**.
 *  - The task list: a dnd-kit vertical `SortableContext` of `TaskListItem`s. A drop
 *    dispatches `tasks.reorder({ taskId, toIndex })`; the store reconciles from the
 *    `taskReordered` event (never optimistically, §5.2).
 *  - The modals it launches: `NewTaskModal`, `DeleteTaskConfirm`, `SettingsModal`, and
 *    (window-view feature) `CreateViewConfirm`. `SettingsModal`
 *    mounts here but its open/closed state lives in the store (`settingsOpen`/`openSettings`/
 *    `closeSettings`), not a local `useState`, so other UI (e.g. the Jira Import modal) can open
 *    Settings too — this is the only mount of `SettingsModal` in the app.
 *  - (Window-view feature) each row's right-click "+ New Window From Task" (`TaskListItem`'s
 *    `onCreateView`): if the task has sessions hosted in THIS window's group (main or main's
 *    secondaries), confirms first (`CreateViewConfirm`, since those sessions are about to move);
 *    otherwise dispatches `views.create` immediately. A failed ack pushes an error toast —
 *    the same `pushToast` pattern used throughout the renderer.
 *
 * Each row leads with its aggregate status icon (§5.4, §9): a `taskDisplayState`
 * roll-up (§3.4/§9.5, folding session state + ready-for-review) is derived per task
 * from the store and passed to `TaskListItem`.
 *
 * `readOnly` (window-view feature, Task 5): renders the VIEW window's own permanently
 * non-interactive copy of this panel — every task is listed (so the user can still see
 * the whole workspace at a glance) with the viewed task shown selected via the normal
 * `activeTaskId` (a view window's `activeTaskId` is pinned to its `viewTaskId`, store.ts),
 * but nothing here can switch/drag/reorder/rename, and the New Task / Delete Task / New
 * Window / grouping-toggle / Issues controls are omitted outright (not merely disabled) —
 * none of them apply to a window permanently pinned to one task. `onNewTask` is unused
 * in that mode.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { TaskListItem } from './TaskListItem'
import { DeleteTaskConfirm } from './DeleteTaskConfirm'
import { SettingsModal } from './SettingsModal'
import { CreateViewConfirm } from './CreateViewConfirm'
import { useStore, taskDisplayState, isViewedTask, sameWindowGroup } from '../store/store'
import { groupTasksByRepo, repoKeyOf, NO_REPOSITORY_KEY } from '../store/group-tasks'
import { color, fontSize } from '../style/tokens'
import octopusMascot from '../assets/octopus.svg'

export interface ProgressPanelProps {
  /** Open the New-Task modal (owned by `App` so the new-task shortcut shares it). Unused
   * when `readOnly`. */
  readonly onNewTask: () => void
  /** Window-view feature (Task 5): render the non-interactive variant — see header comment. */
  readonly readOnly?: boolean
}

export function ProgressPanel({
  onNewTask,
  readOnly = false
}: ProgressPanelProps): React.JSX.Element {
  const taskOrder = useStore((s) => s.taskOrder)
  const tasks = useStore((s) => s.tasks)
  const activeTaskId = useStore((s) => s.activeTaskId)
  const setActiveTask = useStore((s) => s.setActiveTask)
  const taskSwitchSettled = useStore((s) => s.taskSwitchSettled)
  const grouped = useStore((s) => s.settings.groupTasksByRepo)
  const setGroupTasksByRepo = useStore((s) => s.setGroupTasksByRepo)
  const issuesDrawerOpen = useStore((s) => s.issuesDrawerOpen)
  const toggleIssuesDrawer = useStore((s) => s.toggleIssuesDrawer)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  // Subscribe to every input `taskDisplayState` folds in so the rollup re-renders when
  // any of them change (§9.5/§9): the finished-unseen map and session states (raise/
  // clear + plain state flips), PLUS the on-screen inputs (window focus + active tab),
  // because the review dot is now suppressed at DISPLAY time for an on-screen session —
  // so a focus change with no state change must still recompute the icon.
  // `taskDisplayState` reads all of these off `useStore.getState()`; these bare
  // subscriptions exist only to trigger the re-render.
  useStore((s) => s.hasUnseenFinishedTurn)
  useStore((s) => s.sessions)
  useStore((s) => s.windowFocused)
  useStore((s) => s.activeSessionByTask)

  // Grouped view: tasks bucketed by owning repo (§5.1), in taskOrder order. Only
  // computed when grouping is on; recomputed when the order or task set changes.
  const groups = useMemo(() => groupTasksByRepo(taskOrder, tasks), [taskOrder, tasks])

  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null)
  // The release/semver version (§10), shown in the title. Static + display-only, so
  // it lives here rather than in the event-projected store (whose `version` is the
  // unrelated feature-set integer). Fetched once; null until it resolves.
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    void window.octopusAPI.app.getVersion().then(setVersion)
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const switchTask = (taskId: string): void => {
    setActiveTask(taskId)
    void window.octopusAPI.tasks.switch({ taskId }).finally(taskSwitchSettled)
  }

  // Window-view feature (Task 2/3): pending confirmation for "+ New Window From Task"
  // when the task has sessions that would move. `null` = no dialog up.
  const [createViewTaskId, setCreateViewTaskId] = useState<string | null>(null)

  const dispatchCreateView = (taskId: string): void => {
    void window.octopusAPI.views
      .create({ taskId })
      .then((ack) => {
        if (!ack.ok) useStore.getState().pushToast('error', ack.error ?? 'Failed to open window')
      })
      .catch(() => useStore.getState().pushToast('error', 'Failed to open window'))
  }

  const requestCreateView = (taskId: string): void => {
    const data = useStore.getState()
    if (isViewedTask(data, taskId)) return // menu item is disabled for this case; double-guard
    const task = data.tasks[taskId]
    // "Has sessions" (per the product spec) means hosted in THIS window's group — main
    // or main's own secondaries — which is exactly what `createView` bulk-moves. A task
    // that's never been started, or whose sessions somehow already live elsewhere, has
    // nothing to confirm moving.
    const hasSessions = task
      ? task.sessionIds.some((id) => {
          const windowId = data.sessions[id]?.windowId
          return windowId !== undefined && sameWindowGroup(data, windowId, data.windowId)
        })
      : false
    if (hasSessions) {
      setCreateViewTaskId(taskId)
    } else {
      dispatchCreateView(taskId)
    }
  }

  const toggleGrouped = (): void => {
    const next = !grouped
    setGroupTasksByRepo(next) // optimistic in-memory flip (no re-hydrate, keeps toasts)
    void window.octopusAPI.app.updateSettings({ groupTasksByRepo: next }) // persist
  }

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const activeId = String(active.id)
    const overId = String(over.id)
    // In the grouped view a task's repo can't change by dragging, so a cross-group
    // drop is a no-op. Same-repo drags map back to a global toIndex: `arrayMove` on
    // the full `taskOrder` between two same-repo positions yields a valid global
    // order (the store reconciles from `taskReordered`, never optimistically, §5.2).
    if (grouped && repoKeyOf(tasks[activeId]) !== repoKeyOf(tasks[overId])) return
    const from = taskOrder.indexOf(activeId)
    const to = taskOrder.indexOf(overId)
    if (from < 0 || to < 0) return
    const reordered = arrayMove([...taskOrder], from, to)
    const toIndex = reordered.indexOf(activeId)
    void window.octopusAPI.tasks.reorder({ taskId: activeId, toIndex })
  }

  const headerButton: React.CSSProperties = { flex: 1 }

  return (
    <aside
      style={{
        width: 240,
        borderRight: `1px solid ${color.border}`,
        display: 'flex',
        flexDirection: 'column',
        background: color.bgSidebar
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 12px 8px', gap: 8 }}>
        {/* Decorative sidebar mascot — the title text already names the app, so
            this is `alt=""`/`aria-hidden`, not a second announcement for screen readers. */}
        <img src={octopusMascot} alt="" aria-hidden width={22} height={22} />
        <h1
          style={{
            fontSize: fontSize.title,
            margin: 0,
            flex: 1,
            letterSpacing: '0.02em',
            color: color.text
          }}
        >
          Octopus{version ? ` - ${version}` : ''}
        </h1>
        {/* Window-view feature: this panel is the VIEW window's pinned, read-only
            copy when `readOnly` — no settings here (nothing it opens applies to this
            window), and no pill either: `App.tsx`'s banner above both panels is the
            single view indicator, so this header stays empty rather than duplicating
            it. */}
        {readOnly ? null : (
          <button
            type="button"
            className="icon-button"
            aria-label="settings"
            onClick={openSettings}
            style={{ fontSize: 20 }}
          >
            ⚙
          </button>
        )}
      </div>

      {readOnly ? null : (
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 12px' }}>
          <button type="button" className="btn-primary" onClick={onNewTask} style={headerButton}>
            + New Task
          </button>
          <button
            type="button"
            onClick={() => setDeleteTaskId(activeTaskId ?? null)}
            disabled={!activeTaskId}
            style={headerButton}
          >
            Delete Task
          </button>
        </div>
      )}

      {/* Open an empty secondary session-only window (V1.5, §6.7); the backend emits
          `windowCreated` and the main process opens the OS window. Shown in a view too:
          the backend parents it to the sender's group, so it joins the view's group. */}
      <div style={{ display: 'flex', padding: '0 12px 12px' }}>
        <button
          type="button"
          onClick={() => void window.octopusAPI.windows.create({})}
          style={{ flex: 1 }}
        >
          + New Window
        </button>
      </div>

      {readOnly ? null : (
        <>
          {/* Toggle between the repo-grouped and flat task views (§5.1); persisted as a
              setting so it survives restart. Grouped is the default. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 12px 12px' }}>
            <button
              type="button"
              onClick={toggleGrouped}
              aria-pressed={grouped}
              aria-label="group tasks by repo"
              title={
                grouped
                  ? 'Grouping by repo — click for a flat list'
                  : 'Flat list — click to group by repo'
              }
            >
              {grouped ? 'Grouped ▾' : 'Flat ▸'}
            </button>
          </div>
        </>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        {grouped ? (
          <ul style={{ margin: 0, padding: 0, overflowY: 'auto', flex: 1 }}>
            {groups.map((g) => (
              <li key={g.repoRoot || 'no-repo'} style={{ listStyle: 'none' }}>
                <div
                  style={{
                    padding: '8px 12px 4px',
                    color: color.muted,
                    fontSize: fontSize.sm,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={g.repoRoot && g.repoRoot !== NO_REPOSITORY_KEY ? g.repoRoot : g.repoName}
                >
                  {g.repoName}
                </div>
                <SortableContext items={[...g.taskIds]} strategy={verticalListSortingStrategy}>
                  <ul style={{ margin: 0, padding: 0 }}>
                    {g.taskIds.map((id) => {
                      const t = tasks[id]
                      if (!t) return null
                      return (
                        <TaskListItem
                          key={id}
                          task={t}
                          active={id === activeTaskId}
                          display={taskDisplayState(useStore.getState(), id)}
                          indent
                          readOnly={readOnly}
                          onActivate={() => switchTask(id)}
                          onRename={(name) => window.octopusAPI.tasks.rename({ taskId: id, name })}
                          onCreateView={readOnly ? undefined : () => requestCreateView(id)}
                        />
                      )
                    })}
                  </ul>
                </SortableContext>
              </li>
            ))}
          </ul>
        ) : (
          <SortableContext items={[...taskOrder]} strategy={verticalListSortingStrategy}>
            <ul style={{ margin: 0, padding: 0, overflowY: 'auto', flex: 1 }}>
              {taskOrder.map((id) => {
                const t = tasks[id]
                if (!t) return null
                return (
                  <TaskListItem
                    key={id}
                    task={t}
                    active={id === activeTaskId}
                    display={taskDisplayState(useStore.getState(), id)}
                    readOnly={readOnly}
                    onActivate={() => switchTask(id)}
                    onRename={(name) => window.octopusAPI.tasks.rename({ taskId: id, name })}
                    onCreateView={readOnly ? undefined : () => requestCreateView(id)}
                  />
                )
              })}
            </ul>
          </SortableContext>
        )}
      </DndContext>

      {/* "Issues" button (PRD "Progress Window" → "Controls"; "Issues" → "Issues
          window"), pinned below the task list: the list above is the `flex: 1`
          scroller, so this sits in the remaining space and never scrolls with it.
          The `id` is a focus-restore fallback target for `IssuesDrawer`:
          if the drawer can't restore focus to whatever had it before opening (or
          to an on-screen terminal), it lands here instead of `<body>`.
          Window-view feature: the Issues drawer is main-only (DESIGN §13.4/§13.5) —
          omitted entirely in the `readOnly` (view-window) panel, not just disabled,
          since `IssuesDrawer` itself is never mounted there either (`App.tsx`). */}
      {readOnly ? null : (
        <div style={{ padding: 12, borderTop: `1px solid ${color.border}` }}>
          <button
            id="issues-drawer-toggle"
            data-issues-drawer-control
            type="button"
            onClick={toggleIssuesDrawer}
            aria-pressed={issuesDrawerOpen}
            style={{ width: '100%' }}
          >
            Issues
          </button>
        </div>
      )}

      {deleteTaskId && tasks[deleteTaskId] ? (
        <DeleteTaskConfirm taskId={deleteTaskId} onClose={() => setDeleteTaskId(null)} />
      ) : null}
      {settingsOpen ? <SettingsModal onClose={closeSettings} /> : null}
      {createViewTaskId && tasks[createViewTaskId] ? (
        <CreateViewConfirm
          taskName={tasks[createViewTaskId].name}
          onClose={() => setCreateViewTaskId(null)}
          onConfirm={() => {
            dispatchCreateView(createViewTaskId)
            setCreateViewTaskId(null)
          }}
        />
      ) : null}
    </aside>
  )
}
