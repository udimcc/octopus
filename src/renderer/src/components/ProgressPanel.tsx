/**
 * The left "Progress" panel (DESIGN §5.1; PRD §Progress Window). It owns:
 *  - `PanelHeader`: the app title + **New Task**, **Delete Task** (disabled when no
 *    active task), and a gear that opens **Settings**.
 *  - The task list: a dnd-kit vertical `SortableContext` of `TaskListItem`s. A drop
 *    dispatches `tasks.reorder({ taskId, toIndex })`; the store reconciles from the
 *    `taskReordered` event (never optimistically, §5.2).
 *  - The modals it launches: `NewTaskModal`, `DeleteTaskConfirm`, `SettingsModal`.
 *
 * Each row leads with its aggregate status icon (§5.4, §9): a `taskDisplayState`
 * roll-up (§3.4/§9.5, folding session state + ready-for-review) is derived per task
 * from the store and passed to `TaskListItem`.
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
import { useStore, taskDisplayState } from '../store/store'
import { groupTasksByRepo, repoKeyOf, NO_REPOSITORY_KEY } from '../store/group-tasks'
import { color, fontSize } from '../style/tokens'

export interface ProgressPanelProps {
  /** Open the New-Task modal (owned by `App` so the new-task shortcut shares it). */
  readonly onNewTask: () => void
}

export function ProgressPanel({ onNewTask }: ProgressPanelProps): React.JSX.Element {
  const taskOrder = useStore((s) => s.taskOrder)
  const tasks = useStore((s) => s.tasks)
  const activeTaskId = useStore((s) => s.activeTaskId)
  const setActiveTask = useStore((s) => s.setActiveTask)
  const grouped = useStore((s) => s.settings.groupTasksByRepo)
  const setGroupTasksByRepo = useStore((s) => s.setGroupTasksByRepo)
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
  const [showSettings, setShowSettings] = useState(false)
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
    void window.octopusAPI.tasks.switch({ taskId })
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
        <button
          type="button"
          className="icon-button"
          aria-label="settings"
          onClick={() => setShowSettings(true)}
        >
          ⚙
        </button>
      </div>

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

      {/* Open an empty secondary session-only window (V1.5, §6.7); the backend emits
          `windowCreated` and the main process opens the OS window. */}
      <div style={{ display: 'flex', padding: '0 12px 12px' }}>
        <button
          type="button"
          onClick={() => void window.octopusAPI.windows.create({})}
          style={{ flex: 1 }}
        >
          + New Window
        </button>
      </div>

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
                          onActivate={() => switchTask(id)}
                          onRename={(name) => window.octopusAPI.tasks.rename({ taskId: id, name })}
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
                    onActivate={() => switchTask(id)}
                    onRename={(name) => window.octopusAPI.tasks.rename({ taskId: id, name })}
                  />
                )
              })}
            </ul>
          </SortableContext>
        )}
      </DndContext>

      {deleteTaskId && tasks[deleteTaskId] ? (
        <DeleteTaskConfirm taskId={deleteTaskId} onClose={() => setDeleteTaskId(null)} />
      ) : null}
      {showSettings ? <SettingsModal onClose={() => setShowSettings(false)} /> : null}
    </aside>
  )
}
