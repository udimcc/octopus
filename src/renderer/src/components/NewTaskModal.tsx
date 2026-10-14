/**
 * The New-Task modal (DESIGN §5.4). A projects sidebar (`ProjectSidebar`) on the
 * left — shared across the "From New Worktree" / "From Existing Repo" tabs,
 * hidden on "No Repo" — lets the user pick, add, remove, or re-point the default
 * branch of a configured repo (`settings.json#projects`, §6.3). There is no
 * native-picker Browse fallback on either repo tab: the only way a repo
 * directory enters a form field is "+ Add project" (which DOES use the native
 * `dialog:pickDirectory`) or picking a row that's already in the sidebar. Three
 * tabs, one dispatch (`tasks.create`):
 *   - **From New Worktree** (default): **name** + the sidebar's selected project
 *     (its path becomes `repoDir`) + **source branch** (prefilled from the
 *     project's `defaultBranch`) + **new branch**. Octopus removes the worktree
 *     on delete.
 *   - **From Existing Repo**: **name** + the sidebar's selected project, whose
 *     main checkout and linked worktrees (`projects.listWorktrees`) are offered
 *     as a radio list split into an "Available" section, then a "Used" one
 *     (rows in use by another task, disabled); an empty section is hidden.
 *     Deleting the task leaves the directory on disk (the worktree is
 *     `managed: false`, §6.4).
 *   - **No Repo**: just a **name** — no worktree, nothing touched on disk. Its
 *     sessions open at the home dir with no `cd`, for ad-hoc work (checking mounts,
 *     `less` on a log, editing a config) unrelated to any repo (§5.4).
 *
 * An info button (top-right) reveals a per-tab tooltip on hover/focus explaining
 * what each mode does — in particular the differing delete behavior.
 *
 * Outcome is mostly driven by the EVENT stream, not the command ack: a
 * provisioning/adoption failure (the script/git step itself) emits `scriptError`
 * (§6.4) — the task record is kept around as `ProvisionFailed` for Retry — and its
 * ack also resolves `{ ok: false }`; whichever lands first shows the error once. So
 * we watch the stream for the terminal signal of the in-flight create — `activeTaskChanged` (success → close) or `scriptError` (failure
 * → inline red block, stay open for Retry) — and surface `scriptProgress` lines live
 * under the spinner. Both tabs emit the same events, so this handling is shared. A
 * `busyRef` gates the handler so only events for OUR create are acted on (the modal
 * is modal, so nothing else changes the active task while it is open). A LATER
 * failure — the post-provisioning persist step — resolves `{ ok: false, error }` on
 * the ack with NO `scriptError` (`createTask`'s header comment, step 5), so `submit`
 * below also checks `ack.ok` directly rather than relying on the event stream alone.
 *
 * `newBranch` is prefilled with `taskNameToBranchSlug(name)` until the user edits
 * it (DESIGN §5.4); `sourceBranch` is required with a `master` placeholder hint (no
 * hardcoded branch policy — the user chooses).
 *
 * **Associated issue** ("Issues"): an "Associated issue" dropdown (`IssuePicker`) —
 * common to all three tabs, rendered once below the task name — lets the user bind a
 * not-Done issue from the store. It is a custom listbox, not a native `<select>`, so
 * each entry shows the same `IssueStatusIcon` as the issue window. Issues already bound to a
 * task are disabled with "(already linked)" (`isIssueBoundElsewhere`, no task
 * yet exists for this draft so every bound issue counts). Picking one fills an
 * empty name (and, through the same
 * `taskNameToBranchSlug` path as typing, the branch — unless the user already edited
 * it) and, if no project is picked yet, selects the issue's project by exact path
 * match. Every `tasks.create` call includes `issueId` when one is picked.
 *
 * `fromIssueId` drives "Create task" from the Issues drawer: the picker locks to that
 * issue, the name is prefilled from it, and the tab is forced to "From New Worktree".
 * The project (if the issue has one AND it is still in the loaded project list) is
 * selected and the branch is derived from the name; otherwise the project is left
 * unselected. This can only run once `projects.list()` has resolved — selecting a
 * project before the list exists would silently no-op — so it is applied in an effect
 * gated on `projectsLoading` turning false, guarded by a ref so it fires once. An
 * issue id that isn't in the store's `issues` is treated as no prefill at all.
 */

import { useEffect, useRef, useState } from 'react'
import { taskNameToBranchSlug } from '../util/slug'
import { ProjectSidebar } from './ProjectSidebar'
import { useStore, isIssueBoundElsewhere } from '../store/store'
import { IssuePicker } from './IssuePicker'
import { cleanIpcError } from '../util/ipc-error'
import {
  overlayStyle,
  modalCardStyle,
  color,
  font,
  fontSize,
  radius,
  shadow
} from '../style/tokens'
import type { ProjectListItemDTO, ProjectWorktreeDTO } from '../../../shared/dto'

export interface NewTaskModalProps {
  /** Close the modal (success or user cancel). */
  readonly onClose: () => void
  /**
   * "Create task" from the Issues drawer ("Issues"): prefill and lock the issue
   * picker to this issue, prefill the name, force the "From New Worktree" tab, and
   * (if the issue has a project still in the loaded list) select it and derive the
   * branch. An id not found in the store's `issues` behaves as no prefill.
   */
  readonly fromIssueId?: string
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

export function NewTaskModal({ onClose, fromIssueId }: NewTaskModalProps): React.JSX.Element {
  const issues = useStore((s) => s.issues)
  const [tab, setTab] = useState<Tab>('new')
  // Info tooltip visibility (hover or keyboard focus of the ⓘ button).
  const [infoOpen, setInfoOpen] = useState(false)
  const [name, setName] = useState('')
  const [sourceBranch, setSourceBranch] = useState('')
  const [newBranch, setNewBranch] = useState('')
  // "From Existing Repo" tab: the worktree path Octopus adopts.
  const [worktreeDir, setWorktreeDir] = useState('')
  // Once the user edits the branch, stop overwriting it from the name.
  const [branchEdited, setBranchEdited] = useState(false)
  // "Associated issue" picker ("Issues"), shared across all three tabs. Set once a
  // confirmed `fromIssueId` prefill applies (see `prefillAppliedRef` below) or by
  // picking the `<select>` directly.
  const [selectedIssueId, setSelectedIssueId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  // Mirrors `busy` for the event handler's stale-closure-free gate.
  const busyRef = useRef(false)

  // ── Projects sidebar state (DESIGN §5.4) ──────────────────────────────────
  const [projects, setProjects] = useState<readonly ProjectListItemDTO[]>([])
  // Nothing is preselected when the modal opens.
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined)
  const [worktrees, setWorktrees] = useState<readonly ProjectWorktreeDTO[]>([])
  // Errors from add/remove/setDefaultBranch, surfaced inline in the sidebar.
  const [sidebarError, setSidebarError] = useState<string | null>(null)
  // Separate from `sidebarError`: a failed `listWorktrees` is about the "existing"
  // tab's radio list, not the sidebar itself, so it gets its own inline line.
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  // True while add/remove/setDefaultBranch is in flight; combined with `busy`
  // (task creation) to gate the whole sidebar.
  const [sidebarBusy, setSidebarBusy] = useState(false)

  // Guards async callbacks (dialog/IPC promises) from setting state after unmount.
  const aliveRef = useRef(true)
  // Bumped on every `listWorktrees` call so a stale response (project changed, or
  // the call was re-issued before the previous one resolved) is dropped.
  const worktreeRequestIdRef = useRef(0)
  // True while the initial `projects.list()` on mount is in flight.
  const [projectsLoading, setProjectsLoading] = useState(true)
  // True while `fetchWorktrees` has an in-flight request.
  const [worktreesLoading, setWorktreesLoading] = useState(false)
  // Guards the `fromIssueId` prefill effect to apply at most once.
  const prefillAppliedRef = useRef(false)

  useEffect(() => {
    // StrictMode (dev) mounts, cleans up, and mounts again; re-arm the guard
    // each time the effect body runs so the ref isn't stuck `false` forever.
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refetchProjects = (): void => {
    void window.octopusAPI.projects.list().then(
      (list) => {
        if (!aliveRef.current) return
        setProjectsLoading(false)
        setProjects(list)
      },
      (err: unknown) => {
        if (!aliveRef.current) return
        setProjectsLoading(false)
        setSidebarError(cleanIpcError(err))
      }
    )
  }

  // Only on mount — mutations call `refetchProjects()` themselves.
  useEffect(() => {
    refetchProjects()
  }, [])

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

  const fetchWorktrees = (projectPath: string): void => {
    const requestId = ++worktreeRequestIdRef.current
    setWorktrees([])
    setWorktreeError(null)
    setWorktreesLoading(true)
    void window.octopusAPI.projects.listWorktrees({ projectPath }).then(
      (list) => {
        if (!aliveRef.current || worktreeRequestIdRef.current !== requestId) return
        setWorktreesLoading(false)
        setWorktrees(list)
        // Drop a stale selection if the refreshed list no longer offers it, or
        // now shows it in use by another task.
        setWorktreeDir((prev) => {
          if (prev === '') return prev
          const match = list.find((wt) => wt.path === prev)
          return match && !match.usedByTaskName ? prev : ''
        })
      },
      (err: unknown) => {
        if (!aliveRef.current || worktreeRequestIdRef.current !== requestId) return
        setWorktreesLoading(false)
        setWorktreeError(cleanIpcError(err))
      }
    )
  }

  /** Common tail of selecting a project, whether from the sidebar or a fresh add. */
  const applyProjectSelection = (path: string, defaultBranch: string | undefined): void => {
    setSelectedPath(path)
    setWorktreeDir('')
    setWorktrees([])
    setWorktreeError(null)
    setSourceBranch(defaultBranch ?? '')
    if (tab === 'existing') fetchWorktrees(path)
  }

  // The issue `fromIssueId` prefills from, once it exists in the store — `undefined`
  // means either no prefill was requested, or the id isn't (yet, or ever) a known
  // issue, in which case the picker stays unlocked and the effect below never fires.
  const prefillIssue = fromIssueId ? issues[fromIssueId] : undefined

  // "Associated issue" options ("Issues"): not-Done issues, newest first, plus the
  // currently selected one even if it since became Done (so the picker can always
  // show its own `value`).
  const issueOptions = Object.values(issues)
    .filter((issue) => issue.status !== 'done' || issue.id === selectedIssueId)
    .sort((a, b) => b.createdAt - a.createdAt)

  const onSelectIssue = (issueId: string): void => {
    if (issueId === '') {
      // Clearing the picker does not clear the name/branch/project it may have filled.
      setSelectedIssueId(undefined)
      return
    }
    setSelectedIssueId(issueId)
    const issue = issues[issueId]
    if (!issue) return
    if (name.trim() === '') onNameChange(issue.name)
    if (!selectedPath && issue.projectPath) {
      const project = projects.find((p) => p.path === issue.projectPath)
      if (project) applyProjectSelection(project.path, project.defaultBranch)
    }
  }

  // `fromIssueId` prefill ("Issues", "Create task" from the drawer): locks the
  // picker, fills the name, forces the "From New Worktree" tab, and — only once
  // `projects.list()` has resolved, so the path lookup isn't done against an empty
  // list — selects the issue's project (if still configured) and derives the branch.
  // Applies at most once; an id that never resolves to a known issue just never runs.
  useEffect(() => {
    if (!fromIssueId || prefillAppliedRef.current || projectsLoading) return
    const issue = issues[fromIssueId]
    if (!issue) return
    prefillAppliedRef.current = true
    setTab('new')
    setSelectedIssueId(fromIssueId)
    // Via `onNameChange`, not a bare `setName`: that's the only path
    // that also derives `newBranch` from the name when there's no project match
    // below to re-derive it explicitly (and matches every other name-setting path
    // in this component, keeping the "haven't edited the branch yet" invariant
    // consistent regardless of where the name came from).
    onNameChange(issue.name)
    const project = issue.projectPath
      ? projects.find((p) => p.path === issue.projectPath)
      : undefined
    if (project) {
      applyProjectSelection(project.path, project.defaultBranch)
      setNewBranch(taskNameToBranchSlug(issue.name))
    }
  }, [fromIssueId, projectsLoading, issues, projects])

  const onSelectProject = (path: string): void => {
    // Re-selecting the selected project keeps the draft: both clicks of a
    // double-click into the default-branch editor reach `onSelect`, and
    // `applyProjectSelection` would reset sourceBranch / worktreeDir. The one
    // exception is retrying a failed worktree list on the Existing tab.
    if (path === selectedPath) {
      if (tab === 'existing' && worktreeError !== null) fetchWorktrees(path)
      return
    }
    setSidebarError(null)
    const project = projects.find((p) => p.path === path)
    applyProjectSelection(path, project?.defaultBranch)
  }

  const changeTab = (next: Tab): void => {
    setTab(next)
    if (next === 'existing' && selectedPath) {
      fetchWorktrees(selectedPath)
    } else if (next === 'new' && selectedPath && sourceBranch.trim() === '') {
      // Only re-prefill when empty, so an edit made before switching away isn't
      // clobbered on switching back (switching tabs never changes the selected
      // project, so this is mostly a safety net for the initial empty case).
      const project = projects.find((p) => p.path === selectedPath)
      setSourceBranch(project?.defaultBranch ?? '')
    }
  }

  const onAddProject = (): void => {
    setSidebarError(null)
    void window.octopusAPI.dialog.pickDirectory().then(
      (dir) => {
        if (!aliveRef.current) return
        if (!dir) return // cancelled
        setSidebarBusy(true)
        void window.octopusAPI.projects.add({ dir }).then((ack) => {
          if (!aliveRef.current) return
          setSidebarBusy(false)
          if (!ack.ok) {
            setSidebarError(ack.error ?? 'Failed to add project')
            return
          }
          setSidebarError(null)
          refetchProjects()
          if (ack.project) applyProjectSelection(ack.project.path, ack.project.defaultBranch)
        })
      },
      (err: unknown) => {
        if (!aliveRef.current) return
        setSidebarError(cleanIpcError(err))
      }
    )
  }

  const onRemoveProject = (path: string): void => {
    setSidebarBusy(true)
    void window.octopusAPI.projects.remove({ path }).then((ack) => {
      if (!aliveRef.current) return
      setSidebarBusy(false)
      if (!ack.ok) {
        setSidebarError(ack.error ?? 'Failed to remove project')
      } else {
        setSidebarError(null)
      }
      refetchProjects()
      if (ack.ok && path === selectedPath) {
        setSelectedPath(undefined)
        setWorktrees([])
        setWorktreeDir('')
        setWorktreeError(null)
        worktreeRequestIdRef.current++
      }
    })
  }

  const onSetProjectDefaultBranch = (path: string, branch: string): void => {
    setSidebarBusy(true)
    void window.octopusAPI.projects
      .setDefaultBranch({ path, defaultBranch: branch })
      .then((ack) => {
        if (!aliveRef.current) return
        setSidebarBusy(false)
        if (!ack.ok) {
          setSidebarError(ack.error ?? 'Failed to set default branch')
        } else {
          setSidebarError(null)
        }
        refetchProjects()
        // Deliberately does not touch this task's `sourceBranch` draft.
      })
  }

  const canSubmit =
    !busy &&
    name.trim() !== '' &&
    (tab === 'new'
      ? !!selectedPath && sourceBranch.trim() !== '' && newBranch.trim() !== ''
      : tab === 'existing'
        ? !!selectedPath && worktreeDir.trim() !== ''
        : true) // 'none': only a name is required

  const submit = (): void => {
    if (!canSubmit) return
    setBusy(true)
    busyRef.current = true
    setError(null)
    setProgress('')
    const issueId = selectedIssueId
    const input =
      tab === 'new'
        ? {
            mode: 'new' as const,
            name: name.trim(),
            repoDir: (selectedPath ?? '').trim(),
            sourceBranch: sourceBranch.trim(),
            newBranch: newBranch.trim(),
            ...(issueId ? { issueId } : {})
          }
        : tab === 'existing'
          ? {
              mode: 'existing' as const,
              name: name.trim(),
              worktreeDir: worktreeDir.trim(),
              ...(issueId ? { issueId } : {})
            }
          : { mode: 'none' as const, name: name.trim(), ...(issueId ? { issueId } : {}) }
    void window.octopusAPI.tasks.create(input).then(
      (ack) => {
        // Any `{ ok: false }` ack: a provisioning/adoption failure (which also
        // emits `scriptError`, handled above — `busyRef` makes whichever lands
        // first win) or a persist-step failure (no `scriptError`).
        if (!ack.ok && busyRef.current) {
          busyRef.current = false
          setBusy(false)
          setError(ack.error ?? 'Failed to create task')
        }
      },
      (err: unknown) => {
        // The IPC call itself rejected (e.g. a dropped main-process dispatch) —
        // no ack, so nothing above would otherwise clear `busy`.
        if (!busyRef.current) return
        busyRef.current = false
        setBusy(false)
        setError(cleanIpcError(err))
      }
    )
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Stop every key here from reaching the window-level shortcut listener, like
    // every other modal: otherwise keys typed here (e.g. while naming the task)
    // would also fire app-level shortcuts.
    e.stopPropagation()
    if (e.key === 'Escape' && !busy) onClose()
    // Only a plain text input (name / source branch / new branch) submits on
    // Enter — not a button (Cancel, Create, the sidebar's 🗑/✓/✗) and not the
    // worktree radios. This also naturally respects a sidebar row's own Enter
    // handler, which stops propagation before this ever runs.
    if (
      e.key === 'Enter' &&
      canSubmit &&
      e.target instanceof HTMLInputElement &&
      e.target.type === 'text'
    ) {
      submit()
    }
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    color: color.textSecondary,
    fontSize: fontSize.sm
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
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ ...modalCardStyle, width: 640 }}
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
            disabled={busy || sidebarBusy}
            onClick={() => changeTab('new')}
          >
            From New Worktree
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'existing'}
            className={tab === 'existing' ? 'btn-primary' : undefined}
            disabled={busy || sidebarBusy}
            onClick={() => changeTab('existing')}
          >
            From Existing Repo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'none'}
            className={tab === 'none' ? 'btn-primary' : undefined}
            disabled={busy || sidebarBusy}
            onClick={() => changeTab('none')}
          >
            No Repo
          </button>
        </div>

        <div style={{ display: 'flex', gap: 12, minHeight: 0 }}>
          {tab !== 'none' ? (
            <ProjectSidebar
              projects={projects}
              selectedPath={selectedPath}
              busy={busy || sidebarBusy}
              loading={projectsLoading}
              error={sidebarError}
              onSelect={onSelectProject}
              onAdd={onAddProject}
              onRemove={onRemoveProject}
              onSetDefaultBranch={onSetProjectDefaultBranch}
            />
          ) : null}

          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 12
            }}
          >
            <label style={labelStyle}>
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

            <div style={labelStyle}>
              <span>Associated issue</span>
              <IssuePicker
                issues={issueOptions}
                value={selectedIssueId}
                disabled={busy || !!prefillIssue}
                onChange={onSelectIssue}
                isUnavailable={isIssueBoundElsewhere}
                unavailableNote="(already linked)"
              />
            </div>

            {tab === 'new' ? (
              <>
                {!selectedPath ? (
                  <p style={{ margin: 0, color: color.muted, fontSize: fontSize.sm }}>
                    Select a project in the sidebar.
                  </p>
                ) : null}

                <label style={labelStyle}>
                  <span>Source branch</span>
                  <input
                    aria-label="source branch"
                    value={sourceBranch}
                    placeholder="master"
                    disabled={busy}
                    onChange={(e) => setSourceBranch(e.target.value)}
                  />
                </label>

                <label style={labelStyle}>
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
              <div style={labelStyle}>
                <span>Worktree</span>
                {!selectedPath ? (
                  <p style={{ margin: 0, color: color.muted, fontSize: fontSize.sm }}>
                    Select a project in the sidebar.
                  </p>
                ) : worktreesLoading ? (
                  <p style={{ margin: 0, color: color.muted, fontSize: fontSize.sm }}>Loading…</p>
                ) : worktrees.length === 0 && !worktreeError ? (
                  <p style={{ margin: 0, color: color.muted, fontSize: fontSize.sm }}>
                    No worktrees found.
                  </p>
                ) : (
                  <div
                    role="radiogroup"
                    aria-label="worktrees"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                      maxHeight: 320,
                      overflowY: 'auto'
                    }}
                  >
                    {(
                      [
                        ['Available', worktrees.filter((wt) => !wt.usedByTaskName)],
                        ['Used', worktrees.filter((wt) => !!wt.usedByTaskName)]
                      ] as const
                    ).map(([label, group]) =>
                      // An empty section is hidden entirely, label included.
                      group.length === 0 ? null : (
                        <div
                          key={label}
                          role="group"
                          aria-label={label}
                          style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                        >
                          <span style={{ color: color.muted, fontSize: fontSize.sm }}>{label}</span>
                          {group.map((wt) => (
                            <label
                              key={wt.path}
                              title={
                                wt.usedByTaskName
                                  ? `${wt.path} — in use by ${wt.usedByTaskName}`
                                  : wt.path
                              }
                              style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 6,
                                color: wt.usedByTaskName ? color.muted : color.textSecondary
                              }}
                            >
                              <input
                                type="radio"
                                name="existing-worktree"
                                checked={worktreeDir === wt.path}
                                disabled={!!wt.usedByTaskName || busy}
                                onChange={() => setWorktreeDir(wt.path)}
                              />
                              <span
                                style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                {wt.path}
                                {wt.branch ? ` (${wt.branch})` : ''}
                                {wt.usedByTaskName ? ` — in use by ${wt.usedByTaskName}` : ''}
                              </span>
                            </label>
                          ))}
                        </div>
                      )
                    )}
                  </div>
                )}
                {worktreeError ? (
                  <p
                    role="alert"
                    style={{ margin: 0, color: color.errorText, fontSize: fontSize.sm }}
                  >
                    {worktreeError}
                  </p>
                ) : null}
              </div>
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

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 'auto' }}>
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={submit} disabled={!canSubmit}>
                {error ? 'Retry' : 'Create Task'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
