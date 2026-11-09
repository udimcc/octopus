/**
 * The Issues drawer's right pane (PRD "Issues" → "Issues window"; DESIGN §13.5).
 * Four modes, chosen by the store's `selectedIssueId`/`issueDraft` plus this
 * component's own `editing` flag:
 *
 * - **Empty** — nothing selected and no draft in progress.
 * - **View** — an existing issue, read-only: name, then a toolbar (a status `<select>`
 *   that persists immediately via `issues.update` — Jira-style, no Edit needed — and the
 *   action buttons), then project/linked task and the markdown description. While the
 *   issue is Blocked, a divider + "Blocked reasons" section follows (markdown, or a
 *   muted "No reason given" when empty/whitespace-only).
 * - **Edit** — the same issue, name/description/project turned into editable fields.
 *   Status is not part of this form: it's only changed from the View toolbar.
 *   A **Blocked reasons** textarea follows Description, shown only while the LIVE store
 *   issue's status is `'blocked'` (a Board drag mid-edit shows/hides it); its state is
 *   kept while hidden, still counts toward dirty, and is always sent on Save.
 * - **Draft** — the "+ New Issue" form (`issueDraft`; no Blocked reasons field); Save creates the issue then
 *   selects it, Cancel discards directly via the new `cancelNewIssue` store action
 *   (an explicit Cancel click is not the same as the dirty-guard's discard prompt —
 *   it already means "discard", so it must not raise one).
 *
 * Dirty tracking (`issueEditDirty`) is computed by comparing the live form fields
 * against their "original" (the current `issue`'s committed values in Edit mode,
 * blank in Draft mode) on every keystroke, and pushed to the store from the same
 * `onNameChange`/`onDescriptionChange`/`onBlockedReasonsChange`/`onProjectChange`
 * handlers — not from a
 * reactive effect — so a store-driven transition into a fresh draft (started via
 * `startNewIssue`, or via `confirmDiscard`'s `'new'` branch, both of which already
 * reset `issueEditDirty` to `false` themselves) can't race with a leftover `dirty`
 * computed from stale local field state.
 *
 * Delete has two shapes (PRD "Deleting"): an unbound issue gets a plain inline
 * confirm; a bound issue gets `BoundDeleteDialog`'s three-way choice. Both, plus
 * `LinkTaskPicker`, are rendered as fixed-position overlays, each own `onKeyDown`
 * stopping Escape from bubbling past it to `IssuesDrawer`'s own handler (which would
 * otherwise close the whole drawer instead of just the nested dialog). All three are
 * portaled to `document.body`: this component is mounted deep inside
 * the Issues drawer, whose slide-in CSS `transform` becomes the *containing block*
 * for a `position: fixed` descendant — without the portal, an overlay's full-viewport
 * backdrop would be confined to the drawer's own bounds, leaving the Progress panel
 * clickable right through it. `createPortal` only moves the raw DOM placement; React
 * event bubbling (so `stopPropagation` reaching `IssuesDrawer`'s handler) is
 * unaffected, since it follows the React tree, not the DOM tree.
 *
 * This pane stays mounted unconditionally by `IssuesDrawer` across both the List and
 * Board tabs — only `IssueList`/`KanbanBoard` swap next to it — so its local edit-form
 * state (`editing`, the field values, dirty tracking, …) survives a tab switch
 * untouched; a tab switch never resets `issueEditSession` either, so none of the
 * effects keyed on it fire. Its width is a fixed share of the drawer that depends on the
 * tab (`ISSUE_VIEW_WIDTH_SHARE`, see that constant): smaller on the Board so its five
 * columns fit.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/store'
import { IssueMarkdown } from './IssueMarkdown'
import { IssueStatusIcon, ISSUE_STATUS_LABELS, ISSUE_STATUS_ORDER } from './IssueStatusIcon'
import { BoundDeleteDialog, type BoundDeleteChoice } from './BoundDeleteDialog'
import { LinkTaskPicker } from './LinkTaskPicker'
import { repoBasename } from '../store/group-tasks'
import { overlayStyle, modalCardStyle, color, fontSize } from '../style/tokens'
import { cleanIpcError } from '../util/ipc-error'
import type { IssueStatusDTO, ProjectListItemDTO } from '../../../shared/dto'

export interface IssueDetailProps {
  readonly onCreateTaskFromIssue: (issueId: string) => void
  readonly onDeleteBoundTask: (taskId: string, alsoDeleteIssue: boolean) => void
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  color: color.textSecondary,
  fontSize: fontSize.sm
}

/** Native `<select>`s size to their content instead of stretching across the form. */
const selectStyle: React.CSSProperties = { alignSelf: 'flex-start', minWidth: 220 }

/** Keeps the form fields and the read-only view a readable width on a wide drawer. */
const CONTENT_MAX_WIDTH = 760

/**
 * The issue-view pane's fixed share of the drawer width, per tab (DESIGN §13.5). The
 * List/Board pane fills the rest. The Board gets more room (60%) because its five columns
 * need 5 × `COLUMN_MIN_WIDTH` (1100px) before it scrolls sideways; at the List's 39% the
 * Done column sat off-screen behind the issue view. A fixed flex-basis (`0 0 …`) rather
 * than a grow weight keeps each share exact whatever sits beside it.
 */
const ISSUE_VIEW_WIDTH_SHARE = { list: '61%', board: '40%' } as const

/** Modest floor so the pane stays usable on a narrow window; not a content minimum. */
const ISSUE_VIEW_MIN_WIDTH = 360

export function IssueDetail({
  onCreateTaskFromIssue,
  onDeleteBoundTask
}: IssueDetailProps): React.JSX.Element {
  const issues = useStore((s) => s.issues)
  const tasks = useStore((s) => s.tasks)
  const selectedIssueId = useStore((s) => s.selectedIssueId)
  const issueDraft = useStore((s) => s.issueDraft)
  const issueEditDirty = useStore((s) => s.issueEditDirty)
  const issueEditSession = useStore((s) => s.issueEditSession)
  const drawerTab = useStore((s) => s.issuesDrawerTab)
  const setIssueEditDirty = useStore((s) => s.setIssueEditDirty)
  const cancelNewIssue = useStore((s) => s.cancelNewIssue)

  const issue = selectedIssueId ? issues[selectedIssueId] : undefined
  const boundTask = issue?.taskId ? tasks[issue.taskId] : undefined

  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [projectPath, setProjectPath] = useState<string | undefined>(undefined)
  const [blockedReasons, setBlockedReasons] = useState('')

  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [deleteStep, setDeleteStep] = useState<'none' | 'simple' | 'bound'>('none')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [showLinkPicker, setShowLinkPicker] = useState(false)

  const [projects, setProjects] = useState<readonly ProjectListItemDTO[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const loadProjects = useCallback((): void => {
    setProjectsLoading(true)
    setProjectsError(null)
    void window.octopusAPI.projects.list().then(
      (list) => {
        if (!aliveRef.current) return
        setProjectsLoading(false)
        setProjects(list)
      },
      (err: unknown) => {
        if (!aliveRef.current) return
        setProjectsLoading(false)
        setProjectsError(cleanIpcError(err))
      }
    )
  }, [])

  // Fetch the project list each time a form actually needs it — entering edit mode,
  // or a fresh draft starting — rather than once ever on mount: the list can
  // change while the drawer sits in View/Empty mode (projects added/removed
  // elsewhere), and a form that opened after a failed fetch had no way to retry.
  useEffect(() => {
    if (editing || issueDraft) loadProjects()
  }, [editing, issueDraft, loadProjects])

  // The drawer's selection moved to a genuinely different edit target (a different
  // issue, a draft started/ended, a discard that lands back on an unchanged target,
  // the drawer closing then reopening, or the selection going away entirely — delete
  // elsewhere, or dropped on hydrate) — drop every UI-local state tied to the
  // PREVIOUS target, including busy flags, so neither stale fields NOR a stuck/late
  // busy state can bleed into the new one. Keyed on `issueEditSession`,
  // not `[selectedIssueId, issueDraft]`: those two don't change on a
  // same-issue reselect, a close+reopen, or a discard that lands back on a fresh
  // draft — `issueEditSession` is bumped on every one of those by `store.ts`.
  useEffect(() => {
    setEditing(false)
    setFormBusy(false)
    setFormError(null)
    setStatusBusy(false)
    setStatusError(null)
    setDeleteStep('none')
    setDeleteBusy(false)
    setDeleteError(null)
    setActionBusy(false)
    setActionError(null)
    setShowLinkPicker(false)
  }, [issueEditSession])

  // Reset the draft's fields exactly once per FRESH draft start. `issueDraft &&
  // !issueEditDirty` is true right when a draft begins (`startNewIssue`'s direct path
  // and `confirmDiscard`'s `'new'` branch both set `issueEditDirty: false` themselves)
  // and stays false while the user types (their first edit sets it `true`), so this
  // never re-fires mid-edit and wipes what they've typed.
  const cleanDraft = issueDraft && !issueEditDirty
  useEffect(() => {
    if (cleanDraft) {
      setName('')
      setDescription('')
      setProjectPath(undefined)
      setBlockedReasons('')
    }
  }, [cleanDraft])

  const origName = issueDraft ? '' : (issue?.name ?? '')
  const origDescription = issueDraft ? '' : (issue?.description ?? '')
  const origProjectPath = issueDraft ? undefined : issue?.projectPath

  const origBlockedReasons = issueDraft ? '' : (issue?.blockedReasons ?? '')

  // Compared regardless of the issue's current status: a draft typed while Blocked and
  // then hidden (status changed mid-edit) still counts as unsaved.
  const computeDirty = (n: string, d: string, p: string | undefined, b: string): boolean =>
    n !== origName ||
    d !== origDescription ||
    (p ?? '') !== (origProjectPath ?? '') ||
    b !== origBlockedReasons

  const onNameChange = (value: string): void => {
    setName(value)
    setIssueEditDirty(computeDirty(value, description, projectPath, blockedReasons))
  }
  const onDescriptionChange = (value: string): void => {
    setDescription(value)
    setIssueEditDirty(computeDirty(name, value, projectPath, blockedReasons))
  }
  const onProjectChange = (value: string | undefined): void => {
    setProjectPath(value)
    setIssueEditDirty(computeDirty(name, description, value, blockedReasons))
  }
  const onBlockedReasonsChange = (value: string): void => {
    setBlockedReasons(value)
    setIssueEditDirty(computeDirty(name, description, projectPath, value))
  }

  const startEdit = (): void => {
    if (!issue) return
    setName(issue.name)
    setDescription(issue.description)
    setProjectPath(issue.projectPath)
    setBlockedReasons(issue.blockedReasons)
    setIssueEditDirty(false)
    setFormError(null)
    setEditing(true)
  }

  const cancelEdit = (): void => {
    setEditing(false)
    setIssueEditDirty(false)
    setFormError(null)
  }

  const cancelDraft = (): void => {
    cancelNewIssue()
    setFormError(null)
  }

  const saveEdit = (): void => {
    if (!issue) return
    const trimmedName = name.trim()
    if (trimmedName === '') {
      setFormError('Name is required')
      return
    }
    // Captured at the start of the request and compared on reply: the
    // session bumps on every close/reselect/delete/hydrate-drop, so a late reply
    // for a target the user has since navigated away from can't show its error, or
    // leave busy clinging to, the issue now on screen (the reset effect above
    // already set `formBusy` back to `false` for the new target the moment the
    // session changed, so a mismatched reply must not flip it back on).
    const session = issueEditSession
    setFormBusy(true)
    setFormError(null)
    void window.octopusAPI.issues
      .update({
        issueId: issue.id,
        name: trimmedName,
        description,
        projectPath: projectPath ?? null,
        blockedReasons
      })
      .then(
        (ack) => {
          if (useStore.getState().issueEditSession !== session) return
          setFormBusy(false)
          if (!ack.ok) {
            setFormError(ack.error ?? 'Failed to update issue')
            return
          }
          setIssueEditDirty(false)
          setEditing(false)
        },
        (err: unknown) => {
          if (useStore.getState().issueEditSession !== session) return
          setFormBusy(false)
          setFormError(cleanIpcError(err))
        }
      )
  }

  const saveDraft = (): void => {
    const trimmedName = name.trim()
    if (trimmedName === '') {
      setFormError('Name is required')
      return
    }
    // Captured at the start of the request: compared on reply instead of
    // re-reading `issueDraft` there, which is also true for any LATER fresh draft
    // (e.g. the user cancelled this one and started another before the reply
    // landed) — the session is bumped on every one of those transitions, so it
    // uniquely identifies "the draft this save actually started from".
    const session = issueEditSession
    setFormBusy(true)
    setFormError(null)
    void window.octopusAPI.issues.create({ name: trimmedName, description, projectPath }).then(
      (ack) => {
        if (useStore.getState().issueEditSession !== session) return
        setFormBusy(false)
        if (!ack.ok || !ack.issueId) {
          setFormError(ack.error ?? 'Failed to create issue')
          return
        }
        // Clear dirty FIRST so the guarded `selectIssue` below doesn't itself raise
        // another discard prompt for the draft we just saved.
        setIssueEditDirty(false)
        useStore.getState().selectIssue(ack.issueId)
      },
      (err: unknown) => {
        if (useStore.getState().issueEditSession !== session) return
        setFormBusy(false)
        setFormError(cleanIpcError(err))
      }
    )
  }

  const updateStatus = (status: IssueStatusDTO): void => {
    if (!issue) return
    const session = issueEditSession
    setStatusBusy(true)
    setStatusError(null)
    void window.octopusAPI.issues.update({ issueId: issue.id, status }).then(
      (ack) => {
        if (useStore.getState().issueEditSession !== session) return
        setStatusBusy(false)
        if (!ack.ok) setStatusError(ack.error ?? 'Failed to update status')
      },
      (err: unknown) => {
        if (useStore.getState().issueEditSession !== session) return
        setStatusBusy(false)
        setStatusError(cleanIpcError(err))
      }
    )
  }

  const openDeleteDialog = (): void => {
    setDeleteError(null)
    // Derive from the resolved `boundTask`, not the raw `issue.taskId`: if
    // the bound task no longer exists (deleted elsewhere) `boundTask` is undefined
    // even though `taskId` is still set, and the 'bound' step would otherwise show
    // nothing (its render guard also requires `boundTask`).
    setDeleteStep(boundTask ? 'bound' : 'simple')
  }

  const closeDeleteDialog = (): void => {
    setDeleteStep('none')
    setDeleteError(null)
  }

  // The bound task can disappear out from under an open 'bound' delete step (deleted
  // in another window while this one is up) — fall back to 'none' rather than leave
  // the step stuck pointing at a task that's gone.
  useEffect(() => {
    if (deleteStep === 'bound' && !boundTask) setDeleteStep('none')
  }, [deleteStep, boundTask])

  const deleteIssueOnly = (): void => {
    if (!issue) return
    const session = issueEditSession
    setDeleteBusy(true)
    setDeleteError(null)
    void window.octopusAPI.issues.delete({ issueId: issue.id }).then(
      (ack) => {
        // A successful delete also arrives as the `issueDeleted` event, which (when
        // this is the selected issue) bumps the session itself — so a mismatch here
        // on success just means the reset effect already cleaned up for us.
        if (useStore.getState().issueEditSession !== session) return
        setDeleteBusy(false)
        if (!ack.ok) {
          setDeleteError(ack.error ?? 'Failed to delete issue')
          return
        }
        setDeleteStep('none')
      },
      (err: unknown) => {
        if (useStore.getState().issueEditSession !== session) return
        setDeleteBusy(false)
        setDeleteError(cleanIpcError(err))
      }
    )
  }

  const chooseBoundDelete = (choice: BoundDeleteChoice): void => {
    if (!issue) return
    if (choice === 'issue') {
      deleteIssueOnly()
      return
    }
    if (!boundTask) return
    setDeleteStep('none')
    onDeleteBoundTask(boundTask.id, choice === 'both')
  }

  const unlink = (): void => {
    if (!issue) return
    const session = issueEditSession
    setActionBusy(true)
    setActionError(null)
    void window.octopusAPI.issues.unbind({ issueId: issue.id }).then(
      (ack) => {
        if (useStore.getState().issueEditSession !== session) return
        setActionBusy(false)
        if (!ack.ok) setActionError(ack.error ?? 'Failed to unlink')
      },
      (err: unknown) => {
        if (useStore.getState().issueEditSession !== session) return
        setActionBusy(false)
        setActionError(cleanIpcError(err))
      }
    )
  }

  const inForm = issueDraft || editing

  const errorLine = (message: string | null): React.JSX.Element | null =>
    message ? (
      <p role="alert" style={{ margin: 0, color: color.errorText }}>
        {message}
      </p>
    ) : null

  return (
    <div
      style={{
        flex: `0 0 ${ISSUE_VIEW_WIDTH_SHARE[drawerTab]}`,
        minWidth: ISSUE_VIEW_MIN_WIDTH,
        padding: 16,
        overflowY: 'auto'
      }}
      onKeyDown={(e) => {
        // While a nested confirm is open, let IT own Escape instead of the drawer —
        // see the file header comment for why this guard is needed here.
        if (deleteStep !== 'none' || showLinkPicker) {
          e.stopPropagation()
        }
      }}
    >
      {!issue && !issueDraft ? (
        <p style={{ margin: 0, color: color.muted }}>Select an issue, or create a new one.</p>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            maxWidth: CONTENT_MAX_WIDTH
          }}
        >
          {inForm ? (
            <>
              <label style={labelStyle}>
                <span>Name</span>
                <input
                  aria-label="issue name"
                  value={name}
                  autoFocus
                  disabled={formBusy}
                  onChange={(e) => onNameChange(e.target.value)}
                />
              </label>

              <label style={labelStyle}>
                <span>Description</span>
                <textarea
                  aria-label="issue description"
                  value={description}
                  disabled={formBusy}
                  rows={8}
                  style={{ resize: 'vertical' }}
                  onChange={(e) => onDescriptionChange(e.target.value)}
                />
              </label>

              {!issueDraft && issue?.status === 'blocked' ? (
                <label style={labelStyle}>
                  <span>Blocked reasons</span>
                  <textarea
                    aria-label="issue blocked reasons"
                    value={blockedReasons}
                    disabled={formBusy}
                    rows={8}
                    style={{ resize: 'vertical' }}
                    onChange={(e) => onBlockedReasonsChange(e.target.value)}
                  />
                </label>
              ) : null}

              <label style={labelStyle}>
                <span>Project</span>
                <select
                  aria-label="issue project"
                  value={projectPath ?? ''}
                  disabled={formBusy || projectsLoading}
                  style={selectStyle}
                  onChange={(e) =>
                    onProjectChange(e.target.value === '' ? undefined : e.target.value)
                  }
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.path} value={p.path}>
                      {repoBasename(p.path)}
                    </option>
                  ))}
                </select>
                {projectsError ? (
                  <p
                    role="alert"
                    style={{
                      margin: 0,
                      color: color.errorText,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8
                    }}
                  >
                    {projectsError}
                    <button type="button" onClick={loadProjects}>
                      Retry
                    </button>
                  </p>
                ) : null}
              </label>

              {errorLine(formError)}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  type="button"
                  onClick={issueDraft ? cancelDraft : cancelEdit}
                  disabled={formBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={issueDraft ? saveDraft : saveEdit}
                  disabled={formBusy || name.trim() === ''}
                >
                  Save
                </button>
              </div>
            </>
          ) : (
            <>
              <h2
                style={{
                  margin: 0,
                  fontSize: fontSize.title,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {issue!.name}
              </h2>

              {/* Toolbar: status first (changed in place, like Jira), then actions. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <IssueStatusIcon status={issue!.status} size={16} />
                <select
                  aria-label="issue status"
                  value={issue!.status}
                  disabled={statusBusy}
                  onChange={(e) => updateStatus(e.target.value as IssueStatusDTO)}
                >
                  {ISSUE_STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {ISSUE_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={startEdit}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => onCreateTaskFromIssue(issue!.id)}
                  disabled={!!boundTask}
                >
                  Create task
                </button>
                {/* Always offered, even when already linked: picking a task
                    relinks, silently replacing the current one (PRD "Issues" →
                    "Issues and tasks"). "Unlink task" is additional, not exclusive. */}
                <button type="button" onClick={() => setShowLinkPicker(true)} disabled={actionBusy}>
                  Link task
                </button>
                {boundTask ? (
                  <button type="button" onClick={unlink} disabled={actionBusy}>
                    Unlink task
                  </button>
                ) : null}
                <button type="button" onClick={openDeleteDialog}>
                  Delete
                </button>
              </div>
              {errorLine(statusError)}
              {errorLine(actionError)}

              <div
                style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: color.textSecondary }}
              >
                <span>
                  <span style={{ color: color.muted }}>Project: </span>
                  {issue!.projectPath ? repoBasename(issue!.projectPath) : 'No project'}
                </span>
                <span>
                  <span style={{ color: color.muted }}>Task: </span>
                  {boundTask ? boundTask.name : 'Not linked'}
                </span>
              </div>

              {/* Read-only provenance (DESIGN §13.7): never editable, so it is only
                  rendered here in view mode and omitted from the edit form above. */}
              <span style={{ color: color.muted, fontSize: fontSize.sm }}>
                Source: {issue!.source === 'jira' ? `Jira (${issue!.jiraKey})` : 'Local'}
              </span>

              <IssueMarkdown source={issue!.description} />

              {issue!.status === 'blocked' ? (
                <section
                  aria-label="blocked reasons"
                  style={{
                    borderTop: `1px solid ${color.border}`,
                    paddingTop: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: fontSize.base,
                      color: color.textSecondary
                    }}
                  >
                    Blocked reasons
                  </h3>
                  {issue!.blockedReasons.trim() === '' ? (
                    <p style={{ margin: 0, color: color.muted }}>No reason given</p>
                  ) : (
                    <IssueMarkdown source={issue!.blockedReasons} />
                  )}
                </section>
              ) : null}
            </>
          )}
        </div>
      )}

      {deleteStep === 'simple'
        ? createPortal(
            <div
              role="presentation"
              onClick={deleteBusy ? undefined : closeDeleteDialog}
              style={overlayStyle}
            >
              <div
                role="dialog"
                aria-label="Delete issue"
                aria-modal="true"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Escape' && !deleteBusy) closeDeleteDialog()
                }}
                style={{ ...modalCardStyle, width: 360 }}
              >
                <h2 style={{ margin: 0, fontSize: fontSize.title }}>Delete issue?</h2>
                <p style={{ margin: 0 }}>This cannot be undone.</p>
                {deleteError ? (
                  <p role="alert" style={{ margin: 0, color: color.errorText }}>
                    {deleteError}
                  </p>
                ) : null}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" autoFocus onClick={closeDeleteDialog} disabled={deleteBusy}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={deleteIssueOnly}
                    disabled={deleteBusy}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {deleteStep === 'bound' && issue && boundTask ? (
        <BoundDeleteDialog
          taskName={boundTask.name}
          issueName={issue.name}
          onChoose={chooseBoundDelete}
          onCancel={closeDeleteDialog}
          busy={deleteBusy}
          error={deleteError}
        />
      ) : null}

      {showLinkPicker && issue ? (
        <LinkTaskPicker issueId={issue.id} onClose={() => setShowLinkPicker(false)} />
      ) : null}
    </div>
  )
}
