/**
 * The New-Task modal (DESIGN §5.4). Three tabs, one dispatch (`tasks.create`):
 *   - **From New Worktree** (default): the four inputs to provision a new worktree
 *     — **name**, **repo directory** (native OS picker via `dialog:pickDirectory`),
 *     **source branch**, **new branch**. Octopus removes the worktree on delete.
 *   - **From Existing Repo**: **name** + an existing **repository directory**
 *     Octopus adopts (git detects its owning repo + branch). Deleting the task
 *     leaves the directory on disk (the worktree is `managed: false`, §6.4).
 *   - **No Repo**: just a **name** — no worktree, nothing touched on disk. Its
 *     sessions open at the home dir with no `cd`, for ad-hoc work (checking mounts,
 *     `less` on a log, editing a config) unrelated to any repo (§5.4).
 *
 * An info button (top-right) reveals a per-tab tooltip on hover/focus explaining
 * what each mode does — in particular the differing delete behavior.
 *
 * Outcome is driven by the EVENT stream, not the command ack: `createTask`
 * catches a provisioning/adoption failure and emits `scriptError` while the ack
 * still resolves `ok:true` (§6.4). So we watch the stream for the terminal signal
 * of the in-flight create — `activeTaskChanged` (success → close) or `scriptError`
 * (failure → inline red block, stay open for Retry) — and surface `scriptProgress`
 * lines live under the spinner. Both tabs emit the same events, so this handling
 * is shared. A `busyRef` gates the handler so only events for OUR create are acted
 * on (the modal is modal, so nothing else changes the active task while it is open).
 *
 * `newBranch` is prefilled with `taskNameToBranchSlug(name)` until the user edits
 * it (DESIGN §5.4); `sourceBranch` is required with a `master` placeholder hint (no
 * hardcoded branch policy — the user chooses).
 */

import { useEffect, useRef, useState } from 'react'
import { taskNameToBranchSlug } from '../util/slug'
import {
  overlayStyle,
  modalCardStyle,
  color,
  font,
  fontSize,
  radius,
  shadow
} from '../style/tokens'

export interface NewTaskModalProps {
  /** Close the modal (success or user cancel). */
  readonly onClose: () => void
}

type Tab = 'new' | 'existing' | 'none'

/**
 * Per-tab explanation shown in the info tooltip. Each entry is a pair of
 * paragraphs: the first states the delete behavior, the second explains HOW the
 * worktree is created/removed (repo-local scripts vs. native git defaults, §6.4).
 */
const TAB_INFO: Record<Tab, readonly [string, string]> = {
  new: [
    'Octopus provisions a fresh git worktree for this task and removes it when the task is deleted.',
    'If the repo has create_worktree.sh / delete_worktree.sh, Octopus runs those scripts. Otherwise it uses native git — git worktree add under ~/octopus_repos/ (configurable in Settings), and git worktree remove on delete.'
  ],
  existing: [
    'Octopus uses an existing repository directory as-is (including a repo’s main checkout) — nothing is created.',
    'Deleting the task closes its sessions but leaves the directory on disk. No delete script or git command runs.'
  ],
  none: [
    'A task with no repository — nothing is created or touched on disk. Its sessions open at your home directory (no cd).',
    'For ad-hoc work unrelated to any repo: checking mounts, tailing a log, editing a config file. Deleting the task just closes its sessions.'
  ]
}

export function NewTaskModal({ onClose }: NewTaskModalProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('new')
  // Info tooltip visibility (hover or keyboard focus of the ⓘ button).
  const [infoOpen, setInfoOpen] = useState(false)
  const [name, setName] = useState('')
  const [repoDir, setRepoDir] = useState('')
  const [sourceBranch, setSourceBranch] = useState('')
  const [newBranch, setNewBranch] = useState('')
  // "From Existing Worktree" tab: the directory Octopus adopts.
  const [worktreeDir, setWorktreeDir] = useState('')
  // Once the user edits the branch, stop overwriting it from the name.
  const [branchEdited, setBranchEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  // Mirrors `busy` for the event handler's stale-closure-free gate.
  const busyRef = useRef(false)

  useEffect(() => {
    const unsubscribe = window.octopusAPI.onEvent((event) => {
      if (!busyRef.current) return
      if (event.type === 'scriptProgress') {
        setProgress(event.line)
      } else if (event.type === 'scriptError') {
        busyRef.current = false
        setBusy(false)
        setError(event.stderr.trim() || `${event.script} failed`)
      } else if (event.type === 'activeTaskChanged' && event.taskId) {
        // The new task is now active — provisioning succeeded.
        busyRef.current = false
        onClose()
      }
    })
    return unsubscribe
  }, [onClose])

  const onNameChange = (value: string): void => {
    setName(value)
    if (!branchEdited) setNewBranch(taskNameToBranchSlug(value))
  }

  const onBranchChange = (value: string): void => {
    setBranchEdited(true)
    setNewBranch(value)
  }

  const pickDir = (): void => {
    void window.octopusAPI.dialog.pickDirectory().then((dir) => {
      if (dir) setRepoDir(dir)
    })
  }

  const pickWorktreeDir = (): void => {
    void window.octopusAPI.dialog.pickDirectory().then((dir) => {
      if (dir) setWorktreeDir(dir)
    })
  }

  const canSubmit =
    !busy &&
    name.trim() !== '' &&
    (tab === 'new'
      ? repoDir.trim() !== '' && sourceBranch.trim() !== '' && newBranch.trim() !== ''
      : tab === 'existing'
        ? worktreeDir.trim() !== ''
        : true) // 'none': only a name is required

  const submit = (): void => {
    if (!canSubmit) return
    setBusy(true)
    busyRef.current = true
    setError(null)
    setProgress('')
    const input =
      tab === 'new'
        ? {
            mode: 'new' as const,
            name: name.trim(),
            repoDir: repoDir.trim(),
            sourceBranch: sourceBranch.trim(),
            newBranch: newBranch.trim()
          }
        : tab === 'existing'
          ? { mode: 'existing' as const, name: name.trim(), worktreeDir: worktreeDir.trim() }
          : { mode: 'none' as const, name: name.trim() }
    void window.octopusAPI.tasks.create(input).then((ack) => {
      // Provisioning failures arrive via `scriptError` (handled above); this only
      // catches a dispatch-level rejection (e.g. a future validation ack).
      if (!ack.ok && busyRef.current) {
        busyRef.current = false
        setBusy(false)
        setError(ack.error ?? 'Failed to create task')
      }
    })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && !busy) onClose()
    if (e.key === 'Enter' && canSubmit) submit()
  }

  return (
    <div
      role="presentation"
      onClick={() => {
        if (!busy) onClose()
      }}
      style={overlayStyle}
    >
      <div
        role="dialog"
        aria-label="New Task"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ ...modalCardStyle, width: 420 }}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <h2 style={{ margin: 0, fontSize: fontSize.title }}>New Task</h2>
          <div style={{ position: 'relative', display: 'flex' }}>
            <button
              type="button"
              className="icon-button"
              aria-label="about task sources"
              aria-describedby={infoOpen ? 'new-task-info' : undefined}
              onMouseEnter={() => setInfoOpen(true)}
              onMouseLeave={() => setInfoOpen(false)}
              onFocus={() => setInfoOpen(true)}
              onBlur={() => setInfoOpen(false)}
            >
              ⓘ
            </button>
            {infoOpen ? (
              <div
                id="new-task-info"
                role="tooltip"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  zIndex: 20,
                  marginTop: 4,
                  padding: 8,
                  width: 300,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  background: color.bgSurfaceRaised,
                  color: color.textSecondary,
                  border: `1px solid ${color.border}`,
                  borderRadius: radius.md,
                  boxShadow: shadow.md,
                  fontSize: fontSize.sm,
                  fontWeight: 'normal'
                }}
              >
                {TAB_INFO[tab].map((paragraph) => (
                  <p key={paragraph} style={{ margin: 0 }}>
                    {paragraph}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div role="tablist" aria-label="Task source" style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'new'}
            className={tab === 'new' ? 'btn-primary' : undefined}
            disabled={busy}
            onClick={() => setTab('new')}
          >
            From New Worktree
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'existing'}
            className={tab === 'existing' ? 'btn-primary' : undefined}
            disabled={busy}
            onClick={() => setTab('existing')}
          >
            From Existing Repo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'none'}
            className={tab === 'none' ? 'btn-primary' : undefined}
            disabled={busy}
            onClick={() => setTab('none')}
          >
            No Repo
          </button>
        </div>

        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            color: color.textSecondary,
            fontSize: fontSize.sm
          }}
        >
          <span>Task name</span>
          <input
            aria-label="task name"
            value={name}
            placeholder="My task"
            disabled={busy}
            autoFocus
            onChange={(e) => onNameChange(e.target.value)}
          />
        </label>

        {tab === 'new' ? (
          <>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                color: color.textSecondary,
                fontSize: fontSize.sm
              }}
            >
              <span>Repository directory</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  aria-label="repo directory"
                  value={repoDir}
                  placeholder="Choose a repository…"
                  disabled={busy}
                  readOnly
                  onChange={(e) => setRepoDir(e.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button type="button" onClick={pickDir} disabled={busy}>
                  Browse…
                </button>
              </div>
            </label>

            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                color: color.textSecondary,
                fontSize: fontSize.sm
              }}
            >
              <span>Source branch</span>
              <input
                aria-label="source branch"
                value={sourceBranch}
                placeholder="master"
                disabled={busy}
                onChange={(e) => setSourceBranch(e.target.value)}
              />
            </label>

            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                color: color.textSecondary,
                fontSize: fontSize.sm
              }}
            >
              <span>New branch</span>
              <input
                aria-label="new branch"
                value={newBranch}
                placeholder="feature/my-task"
                disabled={busy}
                onChange={(e) => onBranchChange(e.target.value)}
              />
            </label>
          </>
        ) : tab === 'existing' ? (
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              color: color.textSecondary,
              fontSize: fontSize.sm
            }}
          >
            <span>Repository directory</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                aria-label="existing repo directory"
                value={worktreeDir}
                placeholder="Choose an existing repository…"
                disabled={busy}
                readOnly
                onChange={(e) => setWorktreeDir(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button type="button" onClick={pickWorktreeDir} disabled={busy}>
                Browse…
              </button>
            </div>
          </label>
        ) : null}

        {busy ? (
          <p aria-live="polite" style={{ margin: 0, color: color.muted }}>
            {tab === 'new' ? 'Provisioning worktree…' : 'Adding task…'}
            {/* 'none' resolves instantly via activeTaskChanged; the message flashes briefly. */}
            {progress ? (
              <span style={{ display: 'block', fontFamily: font.mono }}>{progress}</span>
            ) : null}
          </p>
        ) : null}

        {error ? (
          <pre
            role="alert"
            style={{
              margin: 0,
              padding: 8,
              background: color.errorBg,
              color: color.errorText,
              border: `1px solid ${color.errorBorder}`,
              borderRadius: radius.sm,
              whiteSpace: 'pre-wrap',
              overflowX: 'auto',
              maxHeight: 160
            }}
          >
            {error}
          </pre>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={!canSubmit}>
            {error ? 'Retry' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  )
}
