/**
 * The left "Progress" panel (DESIGN §5.1; PRD §Progress Window). It owns:
 *  - `PanelHeader`: the app title + **New Task**, **Delete Task** (disabled when no
 *    active task), and a gear that opens **Settings**.
 *  - The task list: a dnd-kit vertical `SortableContext` of `TaskListItem`s. A drop
 *    dispatches `tasks.reorder({ taskId, toIndex })`; the store reconciles from the
 *    `taskReordered` event (never optimistically, §5.2).
 *  - The modals it launches: `NewTaskModal`, `DeleteTaskConfirm`, `SettingsModal`.
 *
 * No per-task status icon in V1 (a V2 seam, §10) — the row shows the name and a
 * lifecycle suffix only (`TaskListItem`).
 */

import { useState } from 'react'
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
import { useStore } from '../store/store'
import { color } from '../style/tokens'

export interface ProgressPanelProps {
  /** Open the New-Task modal (owned by `App` so the Ctrl+Shift+N shortcut shares it). */
  readonly onNewTask: () => void
}

export function ProgressPanel({ onNewTask }: ProgressPanelProps): React.JSX.Element {
  const taskOrder = useStore((s) => s.taskOrder)
  const tasks = useStore((s) => s.tasks)
  const activeTaskId = useStore((s) => s.activeTaskId)
  const setActiveTask = useStore((s) => s.setActiveTask)

  const [showDelete, setShowDelete] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const switchTask = (taskId: string): void => {
    setActiveTask(taskId)
    void window.octopusAPI.tasks.switch({ taskId })
  }

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = taskOrder.indexOf(String(active.id))
    const to = taskOrder.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const reordered = arrayMove([...taskOrder], from, to)
    const toIndex = reordered.indexOf(String(active.id))
    void window.octopusAPI.tasks.reorder({ taskId: String(active.id), toIndex })
  }

  const headerButton: React.CSSProperties = { flex: 1 }

  return (
    <aside
      style={{
        width: 240,
        borderRight: `1px solid ${color.border}`,
        display: 'flex',
        flexDirection: 'column',
        background: color.panelBg
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: 8, gap: 8 }}>
        <h1 style={{ fontSize: 18, margin: 0, flex: 1 }}>Octopus</h1>
        <button type="button" aria-label="settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '0 8px 8px' }}>
        <button type="button" onClick={onNewTask} style={headerButton}>
          + New Task
        </button>
        <button
          type="button"
          onClick={() => setShowDelete(true)}
          disabled={!activeTaskId}
          style={headerButton}
        >
          Delete Task
        </button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
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
                  onActivate={() => switchTask(id)}
                  onRename={(name) => window.octopusAPI.tasks.rename({ taskId: id, name })}
                />
              )
            })}
          </ul>
        </SortableContext>
      </DndContext>

      {showDelete && activeTaskId ? (
        <DeleteTaskConfirm taskId={activeTaskId} onClose={() => setShowDelete(false)} />
      ) : null}
      {showSettings ? <SettingsModal onClose={() => setShowSettings(false)} /> : null}
    </aside>
  )
}
