/**
 * The delete-task confirmation dialog (DESIGN §5.4, §6.6; PRD §Controls). Deleting
 * a task closes all its sessions and (for an Octopus-provisioned worktree) removes
 * it — irreversible — so it is gated behind an explicit confirm, with the backend's
 * dirty-worktree gate layered on top. An adopted repo (`managed: false`) is left on
 * disk; the body text reflects which case applies:
 *
 *  1. Confirm → `tasks.delete({ taskId })`.
 *  2. If the ack returns `needsDirtyConfirm`, escalate to a second step —
 *     "uncommitted changes — delete anyway?" — and re-dispatch with
 *     `confirmedDirty: true` (§6.6).
 *  3. A Stale / *_failed task offers **Force-forget** (`force: true`): drop it from
 *     the workspace without re-running the (already-broken) worktree script (I4).
 *
 * Success arrives as a `taskDeleted` event (the store removes the task and closes
 * this dialog because `task` becomes undefined). Provisioning/remove failures come
 * back as `scriptError`/`error` → the toaster; we also surface the ack's own error.
 */

import { useState } from 'react'
import { useStore } from '../store/store'
import { overlayStyle, modalCardStyle, color, fontSize } from '../style/tokens'

export interface DeleteTaskConfirmProps {
  readonly taskId: string
  readonly onClose: () => void
}

/** Lifecycles for which the worktree script is known-broken → offer force-forget. */
const FORCE_FORGET_LIFECYCLES = new Set(['stale', 'provision_failed', 'delete_failed'])

export function DeleteTaskConfirm({ taskId, onClose }: DeleteTaskConfirmProps): React.JSX.Element {
  const task = useStore((s) => s.tasks[taskId])
  const [dirtyStep, setDirtyStep] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The task vanished (its `taskDeleted` landed) — nothing left to confirm.
  if (!task) return <></>

  const canForceForget = FORCE_FORGET_LIFECYCLES.has(task.lifecycle)

  const dispatchDelete = (extra: { confirmedDirty?: boolean; force?: boolean }): void => {
    setBusy(true)
    setError(null)
    void window.octopusAPI.tasks.delete({ taskId, ...extra }).then((ack) => {
      if (ack.ok) return // `taskDeleted` will unmount this dialog
      setBusy(false)
      if (ack.needsDirtyConfirm) {
        setDirtyStep(true)
        return
      }
      setError(ack.error ?? 'Failed to delete task')
    })
  }

  // Adopted repos ("From Existing Repo", `managed: false`) are left on disk on
  // delete; only Octopus-provisioned worktrees are removed. Absent worktree
  // (Provisioning/Failed) defaults to the managed wording.
  const managed = task.worktree?.managed !== false

  const title = dirtyStep ? 'Uncommitted changes' : `Delete "${task.name}"?`
  const body = dirtyStep
    ? 'This worktree has uncommitted changes. Delete it anyway? This cannot be undone.'
    : managed
      ? 'This closes all of its sessions and removes its git worktree. This cannot be undone.'
      : 'This closes all of its sessions. The repository directory is left on disk. This cannot be undone.'

  return (
    <div role="presentation" onClick={onClose} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="Delete Task"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) onClose()
        }}
        style={{ ...modalCardStyle, width: 420 }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>{title}</h2>
        <p style={{ margin: 0 }}>{body}</p>

        {error ? (
          <p role="alert" style={{ margin: 0, color: color.errorText }}>
            {error}
          </p>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {canForceForget && !dirtyStep ? (
            <button type="button" onClick={() => dispatchDelete({ force: true })} disabled={busy}>
              Force-forget
            </button>
          ) : null}
          <button
            type="button"
            className="btn-danger"
            onClick={() => dispatchDelete(dirtyStep ? { confirmedDirty: true } : {})}
            disabled={busy}
          >
            {dirtyStep ? 'Delete anyway' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
