/**
 * The delete-task confirmation dialog (DESIGN §6.6, §13.1; PRD §Issues → Deleting).
 * Deleting a task closes all its sessions and (for an Octopus-provisioned worktree)
 * removes it — irreversible — so it is gated behind an explicit confirm, with the
 * backend's dirty-worktree gate layered on top. An adopted repo (`managed: false`)
 * is left on disk; the body text reflects which case applies.
 *
 * **Unbound task** (no `preset`, no connected issue) — unchanged from before Issues:
 *  1. Confirm → `tasks.delete({ taskId })`.
 *  2. If the ack returns `needsDirtyConfirm`, escalate to a second step —
 *     "uncommitted changes — delete anyway?" — and re-dispatch with
 *     `confirmedDirty: true`.
 *  3. A Stale / *_failed task offers **Force-forget** (`force: true`) alongside
 *     Delete at the confirm step: drop it from the workspace without re-running the
 *     (already-broken) worktree script (I4).
 *
 * **Bound task, no `preset`** (the task has a connected issue, via the `issueForTask`
 * reverse lookup, "Issues" §5.4) — the first step is `BoundDeleteDialog` instead of
 * the plain confirm:
 *  - "Delete issue only" dispatches `issues.delete` directly (the task is untouched);
 *    on success this dialog closes itself (the task doesn't disappear, so nothing else
 *    would unmount it).
 *  - "Delete task only" / "Delete both" **are** the confirmation — they dispatch
 *    `tasks.delete({ taskId, alsoDeleteIssue: choice === 'both' })` immediately, with
 *    no extra confirm step, *unless* the task is Force-forget-eligible (see below), in
 *    which case we still want that escape hatch surfaced explicitly: we fall through
 *    to the normal confirm step (title/body as the unbound case) with Force-forget
 *    available, carrying the chosen `alsoDeleteIssue`. `BoundDeleteDialog` itself has
 *    no Force-forget button, so this is the simplest way to keep it reachable.
 *  - The dirty-worktree escalation (above) applies the same way; cancelling it, like
 *    cancelling anywhere else in this flow, deletes nothing and leaves the binding
 *    intact.
 *
 * **`preset` ('task' | 'both')** — the caller (the Issues drawer's own
 * `BoundDeleteDialog`, via `onDeleteBoundTask`) already made the choice; skip the
 * choice step entirely and dispatch `tasks.delete` once, guarded by a ref so
 * React's StrictMode double-invoke of effects can't double-delete. The confirm
 * step still renders underneath (title/body/Force-forget) so that a failure — or
 * `needsDirtyConfirm` — has somewhere to surface; while the first attempt is in
 * flight its buttons are simply disabled via the existing `busy` state, which
 * doubles as the "working" indicator without new UI.
 *
 * Success removing the *task* arrives as a `taskDeleted` event: the store removes
 * the task, so a host that (like `ProgressPanel`) only renders this dialog while
 * `tasks[taskId]` exists will unmount it on its own. `onDone` is called on every
 * successful delete this dialog initiates (issue-only or task), in addition to that,
 * so a host that renders unconditionally (e.g. driven by a preset) has an explicit
 * signal to clear its own "which task" state — kept deliberately simple rather than
 * distinguishing every path. Provisioning/remove failures come back as
 * `scriptError`/`error` → the toaster; we also surface the ack's own error here.
 */

import { useEffect, useRef, useState } from 'react'
import { useStore, issueForTask } from '../store/store'
import { overlayStyle, modalCardStyle, color, fontSize } from '../style/tokens'
import { cleanIpcError } from '../util/ipc-error'
import { BoundDeleteDialog, type BoundDeleteChoice } from './BoundDeleteDialog'

export interface DeleteTaskConfirmProps {
  readonly taskId: string
  readonly onClose: () => void
  /**
   * Skip the choice step: the caller already decided ('task' = keep the issue,
   * 'both' = also delete it). Only meaningful when the task is bound; dispatches
   * `tasks.delete` once, on mount.
   */
  readonly preset?: 'task' | 'both'
  /**
   * Called once a delete this dialog initiated actually succeeds — issue-only or
   * task. See the header comment for why this exists alongside `onClose`.
   */
  readonly onDone?: () => void
}

/** Lifecycles for which the worktree script is known-broken → offer force-forget. */
const FORCE_FORGET_LIFECYCLES = new Set(['stale', 'provision_failed', 'delete_failed'])

type Step = 'choice' | 'confirm' | 'dirty'

export function DeleteTaskConfirm({
  taskId,
  onClose,
  preset,
  onDone
}: DeleteTaskConfirmProps): React.JSX.Element {
  const task = useStore((s) => s.tasks[taskId])
  const boundIssue = useStore((s) => issueForTask(s, taskId))
  // Captured once at open: the 'choice' step's `BoundDeleteDialog` must
  // keep showing the names it opened with even if the underlying task/issue change
  // or disappear out from under it later in the flow (e.g. the issue gets deleted
  // elsewhere mid-choice) — switching this dialog's content under the user is worse
  // than a name that's very slightly stale.
  const [openedTaskName] = useState(() => task?.name ?? '')
  const [openedIssueName] = useState(() => boundIssue?.name)
  const [step, setStep] = useState<Step>(() => (boundIssue && !preset ? 'choice' : 'confirm'))
  const [alsoDeleteIssue, setAlsoDeleteIssue] = useState(preset === 'both')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const presetDispatched = useRef(false)

  const dispatchTaskDelete = (opts: {
    alsoDeleteIssue: boolean
    confirmedDirty?: boolean
    force?: boolean
  }): void => {
    setAlsoDeleteIssue(opts.alsoDeleteIssue)
    setBusy(true)
    setError(null)
    void window.octopusAPI.tasks
      .delete({
        taskId,
        // Omit all three optional keys entirely when not given
        // rather than send them through IPC's structured clone as explicit
        // `false`/`undefined` values — "alsoDeleteIssue"/"confirmedDirty"/"force"
        // being ABSENT is the request shape the backend expects for "not
        // applicable", not present-but-false/undefined.
        ...(opts.alsoDeleteIssue ? { alsoDeleteIssue: true } : {}),
        ...(opts.confirmedDirty !== undefined ? { confirmedDirty: opts.confirmedDirty } : {}),
        ...(opts.force !== undefined ? { force: opts.force } : {})
      })
      .then(
        (ack) => {
          if (ack.ok) {
            onDone?.() // `taskDeleted` also unmounts this dialog via the host's own lookup
            return
          }
          setBusy(false)
          if (ack.needsDirtyConfirm) {
            setStep('dirty')
            return
          }
          setError(ack.error ?? 'Failed to delete task')
        },
        (err: unknown) => {
          setBusy(false)
          setError(cleanIpcError(err))
        }
      )
  }

  const dispatchIssueOnlyDelete = (issueId: string): void => {
    setBusy(true)
    setError(null)
    void window.octopusAPI.issues.delete({ issueId }).then(
      (ack) => {
        setBusy(false)
        if (ack.ok) {
          onDone?.()
          onClose() // the task stays, so nothing else closes this dialog
          return
        }
        setError(ack.error ?? 'Failed to delete issue')
      },
      (err: unknown) => {
        setBusy(false)
        setError(cleanIpcError(err))
      }
    )
  }

  // Preset: the choice was already made by the caller — dispatch once. Guarded
  // against StrictMode's double-invoke of effects.
  useEffect(() => {
    if (!preset || presetDispatched.current) return
    presetDispatched.current = true
    dispatchTaskDelete({ alsoDeleteIssue: preset === 'both' })
    // (This project doesn't lint hook dependency exhaustiveness; dispatchTaskDelete
    // is re-created every render but is only ever invoked once, via the ref guard.)
  }, [preset])

  // The task vanished (its `taskDeleted` landed) — nothing left to confirm.
  if (!task) return <></>

  const canForceForget = FORCE_FORGET_LIFECYCLES.has(task.lifecycle)

  const onChoose = (choice: BoundDeleteChoice): void => {
    if (choice === 'issue') {
      // The issue can vanish mid-choice (deleted elsewhere while this dialog was
      // open) — `boundIssue` goes undefined, but `BoundDeleteDialog` still
      // shows the names captured at open. Surface that instead of silently doing
      // nothing: there is no longer anything to delete.
      if (boundIssue) {
        dispatchIssueOnlyDelete(boundIssue.id)
      } else {
        setError('That issue no longer exists')
      }
      return
    }
    const also = choice === 'both'
    if (canForceForget) {
      // Surface the Force-forget escape hatch explicitly rather than silently
      // applying the default (already-broken) delete path.
      setAlsoDeleteIssue(also)
      setStep('confirm')
      return
    }
    dispatchTaskDelete({ alsoDeleteIssue: also }) // the choice itself is the confirmation
  }

  // Keyed on `step` alone, not also `boundIssue`: once opened onto the
  // choice step, it keeps showing — with the names captured at open — even if the
  // live `boundIssue` disappears mid-choice, rather than silently swapping to the
  // plain confirm dialog under the user.
  if (step === 'choice') {
    return (
      <BoundDeleteDialog
        taskName={openedTaskName}
        issueName={openedIssueName ?? ''}
        onChoose={onChoose}
        onCancel={onClose}
        busy={busy}
        error={error}
      />
    )
  }

  // Adopted repos ("From Existing Repo", `managed: false`) are left on disk on
  // delete; only Octopus-provisioned worktrees are removed. Absent worktree
  // (Provisioning/Failed) defaults to the managed wording.
  const managed = task.worktree?.managed !== false

  const title = step === 'dirty' ? 'Uncommitted changes' : `Delete "${task.name}"?`
  // Also-delete-issue note: appended whenever the issue is actually going
  // to go with the task — `openedIssueName` (not the live `boundIssue`, which may
  // have disappeared) is what proves there WAS one to begin with.
  const alsoIssueNote =
    alsoDeleteIssue && openedIssueName !== undefined
      ? ' Its linked issue will also be deleted.'
      : ''
  const body =
    (step === 'dirty'
      ? 'This worktree has uncommitted changes. Delete it anyway? This cannot be undone.'
      : task.repoLess
        ? // "No Repo" task (§5.4): no worktree, nothing on disk to remove — only its
          // sessions close. No dirty-worktree gate can fire (there is no worktree).
          'This closes all of its sessions. Nothing is removed from disk.'
        : managed
          ? 'This closes all of its sessions and removes its git worktree. This cannot be undone.'
          : 'This closes all of its sessions. The repository directory is left on disk. This cannot be undone.') +
    alsoIssueNote

  return (
    <div role="presentation" onClick={busy ? undefined : onClose} style={overlayStyle}>
      <div
        role="dialog"
        aria-label="Delete Task"
        aria-modal="true"
        tabIndex={-1}
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
          <button type="button" autoFocus onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {canForceForget && step !== 'dirty' ? (
            <button
              type="button"
              onClick={() => dispatchTaskDelete({ alsoDeleteIssue, force: true })}
              disabled={busy}
            >
              Force-forget
            </button>
          ) : null}
          <button
            type="button"
            className="btn-danger"
            onClick={() =>
              dispatchTaskDelete({
                alsoDeleteIssue,
                confirmedDirty: step === 'dirty' ? true : undefined
              })
            }
            disabled={busy}
          >
            {step === 'dirty' ? 'Delete anyway' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
