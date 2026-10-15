/**
 * The Jira Import modal ("Fetch from Jira", DESIGN §13.7). Lets the user search the
 * Jira gateway cache (via `window.octopusAPI.jira`) and import selected issues as
 * read-only-sourced Octopus issues. Follows the shared overlay contract
 * (`.claude/rules/modals-and-overlays.md`): portaled to `document.body` (it opens from
 * inside the Issues drawer, whose own `transform` would otherwise confine a
 * `position: fixed` backdrop to the drawer's bounds), `role="dialog"` +
 * `aria-modal="true"` + `tabIndex={-1}`, and its card's `onKeyDown` stops every key from
 * reaching the window-level shortcut listener before handling its own Escape. No
 * `backdrop-filter`/`filter`/blur (the VDI host has no GPU).
 *
 * State machine, roughly:
 *   1. **Credentials** (`credState`): `'checking'` → `credentials.hasJiraKey()` → either
 *      `'noKey'` (dead-end panel, Open Settings), `'unauthorized'` (same panel, different
 *      wording — the key was rejected) or `'ready'` (loads the project list).
 *   2. **Projects** (`projectsState`): `'loading' | 'error' | 'loaded'`, feeds the Project
 *      `<select>`. A `noKey`/`unauthorized` error from ANY downstream call — projects,
 *      sprints or search, since the key can be revoked mid-session — folds back into
 *      `credState` via `foldCredError` instead of a per-section alert, so there is only
 *      ever ONE "no key"/"key rejected" notice on screen, never one per section.
 *   3. **Sprints** (`sprintsState`), reloaded whenever the chosen project changes:
 *      `'idle'` (no project) → `'loading'` → `'select'` (dropdown, None first) or
 *      `'freetext'` (no sprints found) or `'error'`. `pendingSprintRef` restores the
 *      PREFILLED sprint (from `settings.jira.lastFilters`) exactly once, on whichever
 *      sprint load SUCCEEDS first (normally the initial mount) — an error leaves it
 *      intact so a later Retry can still consume it.
 *   4. **Search** (`searchState`): `'idle' | 'fetching' | 'loadingMore' | 'error' | 'loaded'`.
 *      Fetch persists the filters (`app.updateSettings` + the store's `setJiraLastFilters`)
 *      and clears `nextCursor` first, so a stale "Load more" from the PREVIOUS result set
 *      can't fire mid-fetch and mix pages; Load more is enabled only once `searchState` is
 *      `'loaded'` and a cursor exists. Load more re-calls it with `nextCursor`; a search
 *      error carries the `cursor` it failed on so Retry replays the SAME call. Every call
 *      is tagged with a bumped `searchRequestIdRef` so a stale reply (superseded by a
 *      later Fetch/Load more/Retry) is dropped.
 *   5. **Import** (`importBusy`/`importError`/`importResult`): calls `jira.import` with the
 *      selected keys. Closes the modal only on a clean `{ok:true, skippedKeys:[]}`. A
 *      partial import (some keys skipped) stays open, shows "Imported N; skipped K
 *      (KEYS…)", drops the imported keys from the selection and reclassifies their rows
 *      as Duplicate (they now are, of the issue just created) without a round trip. A
 *      failure before anything was created is shown through `JiraErrorNotice` like any
 *      other Jira error, so it keeps its `kind` (Open Settings / Retry).
 *
 * An Issue key filter overrides the other filters (DESIGN "Product behavior" → Filters):
 * when non-empty it dims/disables Project, Assignee, Days and Sprint, though all are
 * still sent to `jira.search` (and persisted) — the backend ignores them for a keyed
 * search, and keeping them means they're still there if the user later clears the key.
 *
 * "Open Settings" (for `noKey`/`unauthorized`) closes THIS modal first, then calls the
 * store's `openSettings()`: the portaled Jira modal sits after `#root` in the DOM, so it
 * would otherwise paint over the Settings modal.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/store'
import { IssueMarkdown } from './IssueMarkdown'
import { overlayStyle, modalCardStyle, color, font, fontSize, radius } from '../style/tokens'
import { cleanIpcError } from '../util/ipc-error'
import { normalizeJiraIssueKey } from '../../../shared/jira-key'
import type {
  JiraProjectDTO,
  JiraSprintDTO,
  JiraSprintFilterDTO,
  JiraFiltersDTO,
  JiraIssueRowDTO,
  JiraErrorDTO
} from '../../../shared/dto'

export interface JiraImportModalProps {
  /** Close the modal (success, Cancel, Escape, or the backdrop click). */
  readonly onClose: () => void
}

// ── Pure helpers (exported for tests) ──────────────────────────────────────────

/** What `jira.sprints(project)` resolved to for the chosen project. */
type SprintsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: JiraErrorDTO }
  | { readonly kind: 'select'; readonly sprints: readonly JiraSprintDTO[] }
  | { readonly kind: 'freetext' }

/**
 * Resolve the UI's sprint controls (a `<select>` of known sprints, or free text when
 * the project has none) to the `JiraSprintFilterDTO` the backend expects. `undefined`
 * means "no sprint filter" (the dropdown's "None", or an empty free-text field).
 */
export function resolveSprintFilter(
  sprintsState: SprintsState,
  selectValue: string,
  freeText: string
): JiraSprintFilterDTO | undefined {
  if (sprintsState.kind === 'select') {
    if (selectValue === '') return undefined
    const id = Number(selectValue)
    const sprint = sprintsState.sprints.find((s) => s.id === id)
    return sprint ? { kind: 'id', id: sprint.id, name: sprint.name } : undefined
  }
  // A sprint-load error still leaves the free-text field enabled (so the user isn't
  // stuck), so it must be honored the same way `freetext` is rather than silently
  // dropped (M2) — the error notice with Retry stays shown alongside it either way.
  if (sprintsState.kind === 'freetext' || sprintsState.kind === 'error') {
    const trimmed = freeText.trim()
    return trimmed === '' ? undefined : { kind: 'name', text: trimmed }
  }
  return undefined
}

/** Build the `JiraFiltersDTO` sent to `jira.search` (and persisted) from the raw fields. */
export function buildJiraFilters(fields: {
  readonly project: string
  readonly assignee: string
  readonly issueKey: string
  readonly days: string
  readonly sprint: JiraSprintFilterDTO | undefined
}): JiraFiltersDTO {
  const project = fields.project.trim()
  const assignee = fields.assignee.trim()
  const issueKey = normalizeJiraIssueKey(fields.issueKey)
  const rawDays = fields.days.trim()
  const parsedDays = rawDays === '' ? NaN : Number(rawDays)
  // Clamp to the input's own min=1/max=3650 (m3) rather than trust the typed value —
  // a number input still accepts out-of-range values via direct typing/paste.
  const days =
    Number.isFinite(parsedDays) && parsedDays > 0
      ? Math.min(3650, Math.max(1, Math.floor(parsedDays)))
      : undefined
  return {
    ...(project !== '' ? { project } : {}),
    ...(assignee !== '' ? { assignee } : {}),
    ...(issueKey !== undefined ? { issueKey } : {}),
    ...(days !== undefined ? { days } : {}),
    ...(fields.sprint ? { sprint: fields.sprint } : {})
  }
}

/** Append `incoming` rows after `existing`, dropping any already present by `key`. */
export function mergeJiraRows(
  existing: readonly JiraIssueRowDTO[],
  incoming: readonly JiraIssueRowDTO[]
): readonly JiraIssueRowDTO[] {
  const seen = new Set(existing.map((r) => r.key))
  return [...existing, ...incoming.filter((r) => !seen.has(r.key))]
}

/** Keys of the rows that are importable — i.e. not already a Duplicate/Conflict. */
export function selectableJiraKeys(rows: readonly JiraIssueRowDTO[]): readonly string[] {
  return rows.filter((r) => r.classification.kind === 'new').map((r) => r.key)
}

/**
 * How a `JiraErrorDTO` should read and what action it offers, per DESIGN §13.7. `'invalid'`
 * (input rejected before any port call, e.g. a malformed filter) gets no action — unlike
 * `unreachable`/`gateway`, retrying with the SAME input would just fail the same way (m3).
 */
export function describeJiraError(error: JiraErrorDTO): {
  readonly message: string
  readonly action: 'openSettings' | 'retry' | 'none'
} {
  if (error.kind === 'noKey') return { message: 'No Jira API key set.', action: 'openSettings' }
  if (error.kind === 'unauthorized') {
    return { message: 'Jira API key was rejected.', action: 'openSettings' }
  }
  if (error.kind === 'unreachable') {
    return { message: 'Jira gateway unreachable.', action: 'retry' }
  }
  if (error.kind === 'invalid')
    return { message: error.message || 'Invalid filters.', action: 'none' }
  return { message: error.message || 'Jira gateway error.', action: 'retry' }
}

/** Cap on how many issues a single import can carry, mirroring `main/ipc-handlers.ts`'s
 *  `MAX_IMPORT_KEYS` — the renderer can't import main (boundary rule), so it keeps its own
 *  copy to disable Import / cap Select all before the round trip, rather than only after
 *  the backend rejects it (NEW, backend review M8). */
const MAX_IMPORT_KEYS = 500

// ── Component ───────────────────────────────────────────────────────────────────

type CredState = 'checking' | 'noKey' | 'unauthorized' | 'ready'

type ProjectsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: JiraErrorDTO }
  | { readonly kind: 'loaded'; readonly projects: readonly JiraProjectDTO[] }

type SearchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'fetching' }
  | { readonly kind: 'loadingMore' }
  | {
      readonly kind: 'error'
      readonly error: JiraErrorDTO
      readonly retryCursor: string | undefined
    }
  | { readonly kind: 'loaded' }

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  color: color.textSecondary,
  fontSize: fontSize.sm
}

const dimLabelStyle: React.CSSProperties = { ...labelStyle, color: color.muted }

const selectStyle: React.CSSProperties = { minWidth: 160 }

/**
 * Inline error line with the action `describeJiraError` calls for (none for `'invalid'`,
 * m3). For `'unreachable'` the backend's `error.message` may carry a scrubbed diagnostic
 * (e.g. "Jira gateway unreachable (TypeError: UNABLE_TO_VERIFY_LEAF_SIGNATURE)", never a
 * key) — shown as a muted detail line under the fixed headline rather than replacing it.
 */
function JiraErrorNotice({
  error,
  onOpenSettings,
  onRetry
}: {
  readonly error: JiraErrorDTO
  readonly onOpenSettings: () => void
  readonly onRetry: () => void
}): React.JSX.Element {
  const { message, action } = describeJiraError(error)
  const detail =
    error.kind === 'unreachable' && error.message && error.message !== message
      ? error.message
      : undefined
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <p
        style={{ margin: 0, color: color.errorText, display: 'flex', alignItems: 'center', gap: 8 }}
      >
        {message}
        {action === 'openSettings' ? (
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        ) : action === 'retry' ? (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </p>
      {detail ? <span style={{ fontSize: fontSize.sm, color: color.muted }}>{detail}</span> : null}
    </div>
  )
}

export function JiraImportModal({ onClose }: JiraImportModalProps): React.JSX.Element {
  const setJiraLastFilters = useStore((s) => s.setJiraLastFilters)
  const openSettings = useStore((s) => s.openSettings)

  // The modal's own card, focused on open (overlay contract).
  const cardRef = useRef<HTMLDivElement>(null)
  // Guards async callbacks from touching state after unmount.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    cardRef.current?.focus({ preventScroll: true })
    return () => {
      aliveRef.current = false
    }
  }, [])

  // ── Credentials (DESIGN §13.7 error states) ───────────────────────────────────
  const [credState, setCredState] = useState<CredState>('checking')

  // ── Projects ───────────────────────────────────────────────────────────────────
  const [projectsState, setProjectsState] = useState<ProjectsState>({ kind: 'loading' })

  // Fold a `noKey`/`unauthorized` error from ANY downstream call into `credState`
  // instead of a per-section alert — the key can be revoked mid-session, and without
  // this a project-load AND a sprint-load (or search) error firing together would each
  // render their own "key rejected" notice (m7). Returns whether it folded, so the
  // caller skips its own section-level error state when it did.
  const foldCredError = (error: JiraErrorDTO): boolean => {
    if (error.kind === 'noKey') {
      setCredState('noKey')
      return true
    }
    if (error.kind === 'unauthorized') {
      setCredState('unauthorized')
      return true
    }
    return false
  }

  const loadProjects = (): void => {
    setProjectsState({ kind: 'loading' })
    void window.octopusAPI.jira.projects().then(
      (result) => {
        if (!aliveRef.current) return
        if (!result.ok) {
          if (foldCredError(result.error)) return
          setProjectsState({ kind: 'error', error: result.error })
          return
        }
        setProjectsState({ kind: 'loaded', projects: result.value })
      },
      (err: unknown) => {
        if (!aliveRef.current) return
        setProjectsState({ kind: 'error', error: { kind: 'gateway', message: cleanIpcError(err) } })
      }
    )
  }

  useEffect(() => {
    void window.octopusAPI.credentials.hasJiraKey().then(
      (has) => {
        if (!aliveRef.current) return
        if (!has) {
          setCredState('noKey')
          return
        }
        setCredState('ready')
        loadProjects()
      },
      () => {
        if (!aliveRef.current) return
        setCredState('noKey')
      }
    )
    // Runs once, on open; `loadProjects` is only ever called from here or a Retry click.
  }, [])

  // ── Filters, prefilled from the store's settings.jira.lastFilters ────────────
  const [initialFilters] = useState(() => useStore.getState().settings.jira?.lastFilters)
  const [projectInput, setProjectInput] = useState(initialFilters?.project ?? '')
  const [assigneeInput, setAssigneeInput] = useState(initialFilters?.assignee ?? '')
  const [issueKeyInput, setIssueKeyInput] = useState(initialFilters?.issueKey ?? '')
  const [daysInput, setDaysInput] = useState(
    initialFilters?.days !== undefined ? String(initialFilters.days) : ''
  )
  const [sprintSelectValue, setSprintSelectValue] = useState('')
  const [sprintFreeText, setSprintFreeText] = useState('')
  // Consumed at most once, by whichever sprint load happens to be the first
  // (normally the initial mount's, if a project was prefilled).
  const pendingSprintRef = useRef<JiraSprintFilterDTO | undefined>(initialFilters?.sprint)

  // ── Sprints, reloaded on project change ────────────────────────────────────────
  const [sprintsState, setSprintsState] = useState<SprintsState>(
    projectInput.trim() === '' ? { kind: 'idle' } : { kind: 'loading' }
  )
  // Bumped on every call so a stale reply (project changed again mid-flight) is dropped.
  const sprintRequestIdRef = useRef(0)

  const loadSprints = (project: string): void => {
    if (project === '') {
      sprintRequestIdRef.current++
      setSprintsState({ kind: 'idle' })
      return
    }
    const requestId = ++sprintRequestIdRef.current
    setSprintsState({ kind: 'loading' })
    void window.octopusAPI.jira.sprints(project).then(
      (result) => {
        if (!aliveRef.current || sprintRequestIdRef.current !== requestId) return
        if (!result.ok) {
          // Leave `pendingSprintRef` untouched on failure (m5) — only an actually-applied
          // prefill consumes it, so a later Retry can still restore the saved sprint.
          if (foldCredError(result.error)) return
          setSprintsState({ kind: 'error', error: result.error })
          return
        }
        const pending = pendingSprintRef.current
        pendingSprintRef.current = undefined
        if (result.value.length === 0) {
          setSprintsState({ kind: 'freetext' })
          if (pending?.kind === 'name') setSprintFreeText(pending.text)
        } else {
          setSprintsState({ kind: 'select', sprints: result.value })
          if (pending?.kind === 'id' && result.value.some((s) => s.id === pending.id)) {
            setSprintSelectValue(String(pending.id))
          }
        }
      },
      (err: unknown) => {
        if (!aliveRef.current || sprintRequestIdRef.current !== requestId) return
        setSprintsState({ kind: 'error', error: { kind: 'gateway', message: cleanIpcError(err) } })
      }
    )
  }

  const onProjectChange = (value: string): void => {
    setProjectInput(value)
    setSprintSelectValue('')
    setSprintFreeText('')
    loadSprints(value.trim())
  }

  // Fires once on mount to load the prefilled project's sprints (empty-project mounts
  // just set `idle`, matching the initializer above). Later changes go through
  // `onProjectChange` directly, so this intentionally does not depend on `projectInput`.
  useEffect(() => {
    loadSprints(projectInput.trim())
  }, [])

  // "Issue-key mode" (dims/disables the other filters) is derived from the NORMALIZED
  // key, not the raw text (M1): raw invalid text does not actually override anything —
  // `buildJiraFilters` drops it, so the search still runs the OTHER filters — dimming
  // them while that happens would be a lie. Invalid-but-non-empty text instead gets its
  // own inline hint and blocks Fetch outright, since it's ambiguous whether the user
  // meant to search by key or just hasn't finished typing.
  const issueKeyNormalized = normalizeJiraIssueKey(issueKeyInput)
  const issueKeyActive = issueKeyNormalized !== undefined
  const issueKeyInvalid = issueKeyInput.trim() !== '' && issueKeyNormalized === undefined

  const currentFilters = buildJiraFilters({
    project: projectInput,
    assignee: assigneeInput,
    issueKey: issueKeyInput,
    days: daysInput,
    sprint: resolveSprintFilter(sprintsState, sprintSelectValue, sprintFreeText)
  })

  const canFetch = !issueKeyInvalid && (projectInput.trim() !== '' || issueKeyActive)

  // ── Search ─────────────────────────────────────────────────────────────────────
  const [searchState, setSearchState] = useState<SearchState>({ kind: 'idle' })
  const [activeFilters, setActiveFilters] = useState<JiraFiltersDTO | undefined>(undefined)
  const [rows, setRows] = useState<readonly JiraIssueRowDTO[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [detailKey, setDetailKey] = useState<string | undefined>(undefined)
  // Bumped on every search call so a stale reply (a later Fetch/Load more/Retry fired
  // before this one resolved) is dropped.
  const searchRequestIdRef = useRef(0)

  const runSearch = (filters: JiraFiltersDTO, cursor: string | undefined): void => {
    setSearchState(cursor ? { kind: 'loadingMore' } : { kind: 'fetching' })
    const requestId = ++searchRequestIdRef.current
    void window.octopusAPI.jira.search(filters, cursor).then(
      (result) => {
        if (!aliveRef.current || searchRequestIdRef.current !== requestId) return
        if (!result.ok) {
          if (foldCredError(result.error)) return
          setSearchState({ kind: 'error', error: result.error, retryCursor: cursor })
          return
        }
        setSearchState({ kind: 'loaded' })
        // Always route through `mergeJiraRows`, even for a fresh (non-cursor) page, so
        // there's one dedup path rather than two (m11).
        setRows((prev) => mergeJiraRows(cursor ? prev : [], result.value.rows))
        if (!cursor) {
          setSelected(new Set())
          setDetailKey(undefined)
        }
        setNextCursor(result.value.nextCursor)
        setTotal(result.value.total)
      },
      (err: unknown) => {
        if (!aliveRef.current || searchRequestIdRef.current !== requestId) return
        setSearchState({
          kind: 'error',
          error: { kind: 'gateway', message: cleanIpcError(err) },
          retryCursor: cursor
        })
      }
    )
  }

  const onFetch = (): void => {
    if (!canFetch) return
    const filters = currentFilters
    setActiveFilters(filters)
    // Clear the PREVIOUS result set's cursor before the new request starts (H1): without
    // this, "Load more" stays armed with the old cursor/filters pair for the instant
    // between clicking Fetch and the reply landing, and clicking it there would send the
    // NEW `activeFilters` with the OLD `nextCursor` — mixing two result sets. "Load more"
    // itself is only rendered once `searchState` is back to `'loaded'` with a cursor.
    setNextCursor(undefined)
    void window.octopusAPI.app.updateSettings({ jira: { lastFilters: filters } }).then((ack) => {
      // Best-effort persistence (m8) — the search itself doesn't wait on it, matching
      // `ProgressPanel`'s `groupTasksByRepo` toggle, which also fires-and-forgets this
      // call; a failure here just means the next modal open won't prefill these filters.
      if (!ack.ok) console.warn('Failed to persist Jira filters', ack.error)
    })
    setJiraLastFilters(filters)
    runSearch(filters, undefined)
  }

  const onLoadMore = (): void => {
    if (searchState.kind !== 'loaded' || !nextCursor || !activeFilters) return
    runSearch(activeFilters, nextCursor)
  }

  const onRetrySearch = (): void => {
    if (searchState.kind !== 'error' || !activeFilters) return
    runSearch(activeFilters, searchState.retryCursor)
  }

  const toggleSelected = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectable = selectableJiraKeys(rows)
  // Select all never selects more than `MAX_IMPORT_KEYS` (NEW, backend review M8) — it
  // picks the first N importable rows and says so on the button when it had to cap.
  const selectableCapped = selectable.slice(0, MAX_IMPORT_KEYS)
  const allSelectableSelected =
    selectableCapped.length > 0 &&
    selected.size === selectableCapped.length &&
    selectableCapped.every((k) => selected.has(k))

  const onSelectAll = (): void => {
    setSelected(allSelectableSelected ? new Set() : new Set(selectableCapped))
  }

  // ── Import ───────────────────────────────────────────────────────────────────
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<JiraErrorDTO | null>(null)
  const [importResult, setImportResult] = useState<{
    readonly importedCount: number
    readonly skippedKeys: readonly string[]
  } | null>(null)

  const overSelectionCap = selected.size > MAX_IMPORT_KEYS

  const onImport = (): void => {
    if (selected.size === 0 || overSelectionCap || importBusy) return
    const requestedKeys = Array.from(selected)
    setImportBusy(true)
    setImportError(null)
    setImportResult(null)
    void window.octopusAPI.jira.import({ keys: requestedKeys }).then(
      (result) => {
        if (!aliveRef.current) return
        setImportBusy(false)
        if (!result.ok) {
          // `error` is only set when the whole import failed before anything was
          // created (per the DTO doc comment) — no partial-import summary to show,
          // just the error, carrying its `kind` through to `JiraErrorNotice` instead
          // of a bare string (m2).
          setImportError(result.error ?? { kind: 'gateway', message: 'Import failed' })
          return
        }
        if (result.skippedKeys.length > 0) {
          // Partial import (m1): the imported keys are now Duplicates of the issue just
          // created — reclassify their rows locally (the composed name is exactly
          // `KEY: Summary`, per DESIGN "Imported issue shape", so this is accurate
          // without a round trip) and drop them from the selection; the modal stays
          // open so the user can see what happened.
          const importedKeys = new Set(requestedKeys.filter((k) => !result.skippedKeys.includes(k)))
          if (importedKeys.size > 0) {
            setRows((prev) =>
              prev.map((r) =>
                importedKeys.has(r.key)
                  ? {
                      ...r,
                      classification: {
                        kind: 'duplicate',
                        issueId: r.key,
                        issueName: `${r.key}: ${r.summary}`
                      }
                    }
                  : r
              )
            )
            setSelected((prev) => {
              const next = new Set(prev)
              importedKeys.forEach((k) => next.delete(k))
              return next
            })
          }
          setImportResult({ importedCount: result.importedCount, skippedKeys: result.skippedKeys })
          return
        }
        // Fully imported — new issues arrive via `issueUpserted` events; nothing else
        // to apply locally.
        onClose()
      },
      (err: unknown) => {
        if (!aliveRef.current) return
        setImportBusy(false)
        setImportError({ kind: 'gateway', message: cleanIpcError(err) })
      }
    )
  }

  const openSettingsFromError = (): void => {
    // Close THIS modal first — it paints after `#root` in the DOM, so it would
    // otherwise sit on top of the Settings modal.
    onClose()
    openSettings()
  }

  const detailRow = detailKey ? rows.find((r) => r.key === detailKey) : undefined

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Stop every key from reaching the window-level shortcut listener (modals-and-overlays
    // rule), then handle our own Escape.
    e.stopPropagation()
    if (e.key === 'Escape' && !importBusy) onClose()
  }

  return createPortal(
    <div
      role="presentation"
      onClick={() => {
        if (!importBusy) onClose()
      }}
      style={overlayStyle}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-label="Import from Jira"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ ...modalCardStyle, width: 1400, maxHeight: '85vh', overflow: 'hidden' }}
      >
        <h2 style={{ margin: 0, fontSize: fontSize.title }}>Import from Jira</h2>

        {credState === 'checking' ? (
          <p style={{ margin: 0, color: color.muted }}>Checking Jira API key…</p>
        ) : credState === 'noKey' || credState === 'unauthorized' ? (
          // Single dead-end panel for both — only ONE "no key"/"key rejected" notice is
          // ever on screen (m7), since `foldCredError` routes every downstream `noKey`/
          // `unauthorized` error here instead of a per-section alert.
          <>
            <p role="alert" style={{ margin: 0, color: color.errorText }}>
              {credState === 'noKey' ? 'No Jira API key set.' : 'Jira API key was rejected.'}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={openSettingsFromError}>
                Open Settings
              </button>
            </div>
          </>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minHeight: 0,
              overflow: 'hidden'
            }}
          >
            {/* ── Filters ─────────────────────────────────────────────────────── */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <label style={issueKeyActive ? dimLabelStyle : labelStyle}>
                <span>Project</span>
                <select
                  aria-label="Project"
                  value={projectInput}
                  disabled={issueKeyActive || projectsState.kind === 'loading'}
                  style={selectStyle}
                  onChange={(e) => onProjectChange(e.target.value)}
                >
                  <option value="" />
                  {projectsState.kind === 'loaded' ? (
                    <>
                      {/* The remembered project may no longer be in the loaded list (a
                          removed/renamed project) — keep it selectable rather than let the
                          `<select>` silently fall back to blank (m6). */}
                      {projectInput.trim() !== '' &&
                      !projectsState.projects.some((p) => p.key === projectInput) ? (
                        <option value={projectInput}>{projectInput} (not found)</option>
                      ) : null}
                      {projectsState.projects.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.key} ({p.ticketCount})
                        </option>
                      ))}
                    </>
                  ) : null}
                </select>
              </label>

              <label style={issueKeyActive ? dimLabelStyle : labelStyle}>
                <span>Assignee</span>
                <input
                  aria-label="Assignee"
                  value={assigneeInput}
                  disabled={issueKeyActive}
                  onChange={(e) => setAssigneeInput(e.target.value)}
                />
              </label>

              <label style={labelStyle}>
                <span>Issue key</span>
                <input
                  aria-label="Issue key"
                  value={issueKeyInput}
                  placeholder="PROJ-123"
                  onChange={(e) => setIssueKeyInput(e.target.value)}
                />
              </label>

              <label style={issueKeyActive ? dimLabelStyle : labelStyle}>
                <span>Created in last N days</span>
                <input
                  aria-label="Created in last N days"
                  type="number"
                  min={1}
                  max={3650}
                  value={daysInput}
                  disabled={issueKeyActive}
                  style={{ width: 90 }}
                  onChange={(e) => setDaysInput(e.target.value)}
                />
              </label>

              <label style={issueKeyActive ? dimLabelStyle : labelStyle}>
                <span>Sprint</span>
                {sprintsState.kind === 'loading' ? (
                  <span style={{ fontSize: fontSize.sm }}>Loading…</span>
                ) : sprintsState.kind === 'select' ? (
                  <select
                    aria-label="Sprint"
                    value={sprintSelectValue}
                    disabled={issueKeyActive}
                    style={selectStyle}
                    onChange={(e) => setSprintSelectValue(e.target.value)}
                  >
                    <option value="">None</option>
                    {sprintsState.sprints.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.state})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="Sprint"
                    value={sprintFreeText}
                    disabled={issueKeyActive || sprintsState.kind === 'idle'}
                    placeholder="Sprint name contains…"
                    onChange={(e) => setSprintFreeText(e.target.value)}
                  />
                )}
              </label>
            </div>

            {issueKeyInvalid ? (
              <p role="alert" style={{ margin: 0, color: color.errorText, fontSize: fontSize.sm }}>
                Not a valid issue key (e.g. PROJ-123)
              </p>
            ) : issueKeyActive ? (
              <p style={{ margin: 0, color: color.muted, fontSize: fontSize.sm }}>
                Issue key overrides the filters above.
              </p>
            ) : null}

            {projectsState.kind === 'error' ? (
              <JiraErrorNotice
                error={projectsState.error}
                onOpenSettings={openSettingsFromError}
                onRetry={loadProjects}
              />
            ) : null}
            {sprintsState.kind === 'error' ? (
              <JiraErrorNotice
                error={sprintsState.error}
                onOpenSettings={openSettingsFromError}
                onRetry={() => loadSprints(projectInput.trim())}
              />
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                className="btn-primary"
                disabled={
                  !canFetch || searchState.kind === 'fetching' || searchState.kind === 'loadingMore'
                }
                onClick={onFetch}
              >
                {searchState.kind === 'fetching' ? 'Fetching…' : 'Fetch'}
              </button>
              <span style={{ color: color.muted, fontSize: fontSize.sm }}>
                Jira data refreshes every few hours.
              </span>
            </div>

            {/* ── Results + detail ───────────────────────────────────────────── */}
            <div style={{ display: 'flex', gap: 16, minHeight: 0, flex: 1, overflow: 'hidden' }}>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  overflow: 'hidden'
                }}
              >
                {activeFilters ? (
                  <p style={{ margin: 0, color: color.muted, fontSize: fontSize.sm }}>
                    {/* `total` is the gateway's UNFILTERED match count (see the DTO doc
                        comment) — "Showing N of total" is misleading once a sprint filter
                        has narrowed `rows` to fewer than that (m4). */}
                    {activeFilters.sprint
                      ? `${rows.length} matching`
                      : `Showing ${rows.length} of ${total}`}
                  </p>
                ) : null}

                {/* `<ul>`/`<li>` (m9): a `role="row"` inside `role="list"` is invalid ARIA
                    (rows belong under `role="grid"`/`role="table"`, not `list`), and the
                    previous `<div onClick>` row wasn't keyboard-reachable. The checkbox is
                    the row's own control; opening the detail pane is a real `<button>`, so
                    both are focusable and operable with the keyboard without extra handlers. */}
                <ul
                  aria-label="Jira issues"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    overflowY: 'auto',
                    border: `1px solid ${color.border}`,
                    borderRadius: radius.md,
                    padding: 8,
                    margin: 0,
                    listStyle: 'none',
                    minHeight: 200
                  }}
                >
                  {/* Don't claim "No issues found" while Load more could still turn up a
                      match — the sprint filter scans pages server-side and a given page
                      can come back empty before it's exhausted (m4). */}
                  {rows.length === 0 && searchState.kind === 'loaded' && !nextCursor ? (
                    <li style={{ margin: 0, color: color.muted }}>No issues found.</li>
                  ) : null}
                  {rows.map((row) => {
                    const classification = row.classification
                    const notNew = classification.kind !== 'new'
                    const isDetail = detailKey === row.key
                    return (
                      <li
                        key={row.key}
                        data-testid={`jira-row-${row.key}`}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: 6,
                          borderRadius: radius.sm,
                          background: isDetail ? color.bgSelected : 'transparent'
                        }}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.key}`}
                          checked={selected.has(row.key)}
                          disabled={notNew}
                          onChange={() => toggleSelected(row.key)}
                        />
                        <button
                          type="button"
                          aria-pressed={isDetail}
                          onClick={() => setDetailKey(row.key)}
                          // `alignItems: 'stretch'` overrides the global `button` rule's
                          // `align-items: center`, which would center each line of the row.
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'stretch',
                            gap: 2,
                            minWidth: 0,
                            flex: 1,
                            textAlign: 'left',
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            font: 'inherit',
                            color: 'inherit',
                            cursor: 'pointer'
                          }}
                        >
                          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                            <span
                              style={{
                                fontFamily: font.mono,
                                color: notNew ? color.muted : color.text
                              }}
                            >
                              {row.key}
                            </span>
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                color: notNew ? color.muted : color.text
                              }}
                            >
                              {row.summary}
                            </span>
                          </span>
                          <span
                            style={{
                              display: 'flex',
                              gap: 8,
                              flexWrap: 'wrap',
                              fontSize: fontSize.sm,
                              color: color.muted
                            }}
                          >
                            <span>{row.status}</span>
                            <span>{row.type}</span>
                            {row.assignee ? <span>{row.assignee}</span> : null}
                          </span>
                          {classification.kind !== 'new' ? (
                            <span style={{ fontSize: fontSize.sm, color: color.muted }}>
                              {classification.kind === 'duplicate'
                                ? 'Duplicated by '
                                : 'Conflicts with '}
                              {classification.issueName}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>

                {searchState.kind === 'error' ? (
                  <JiraErrorNotice
                    error={searchState.error}
                    onOpenSettings={openSettingsFromError}
                    onRetry={onRetrySearch}
                  />
                ) : nextCursor &&
                  (searchState.kind === 'loaded' || searchState.kind === 'loadingMore') ? (
                  // Only rendered once `searchState` is back to 'loaded' (or already
                  // `loadingMore`) with a cursor — never during a fresh `fetching`, whose
                  // `onFetch` already cleared `nextCursor` (H1).
                  <button
                    type="button"
                    disabled={searchState.kind === 'loadingMore'}
                    onClick={onLoadMore}
                  >
                    {searchState.kind === 'loadingMore' ? 'Loading…' : 'Load more'}
                  </button>
                ) : null}
              </div>

              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  borderLeft: `1px solid ${color.border}`,
                  paddingLeft: 16
                }}
              >
                {detailRow ? (
                  <>
                    <h3 style={{ margin: 0, fontSize: fontSize.lg }}>
                      {detailRow.key}: {detailRow.summary}
                    </h3>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 12,
                        color: color.textSecondary,
                        fontSize: fontSize.sm
                      }}
                    >
                      <span>
                        <span style={{ color: color.muted }}>Status: </span>
                        {detailRow.status}
                      </span>
                      <span>
                        <span style={{ color: color.muted }}>Priority: </span>
                        {detailRow.priority}
                      </span>
                      <span>
                        <span style={{ color: color.muted }}>Type: </span>
                        {detailRow.type}
                      </span>
                      <span>
                        <span style={{ color: color.muted }}>Assignee: </span>
                        {detailRow.assignee ?? '—'}
                      </span>
                      <span>
                        <span style={{ color: color.muted }}>Reporter: </span>
                        {detailRow.reporter ?? '—'}
                      </span>
                      <span>
                        <span style={{ color: color.muted }}>Created: </span>
                        {detailRow.created}
                      </span>
                      <span>
                        <span style={{ color: color.muted }}>Sprint: </span>
                        {detailRow.sprintNames.length > 0 ? detailRow.sprintNames.join(', ') : '—'}
                      </span>
                    </div>
                    <div>
                      <h4 style={{ margin: '4px 0' }}>Description</h4>
                      <IssueMarkdown source={detailRow.descriptionMarkdown} />
                    </div>
                    {detailRow.dodMarkdown ? (
                      <div>
                        <h4 style={{ margin: '4px 0' }}>Definition of Done</h4>
                        <IssueMarkdown source={detailRow.dodMarkdown} />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p style={{ margin: 0, color: color.muted }}>Select a row to see details.</p>
                )}
              </div>
            </div>

            {/* ── Footer ──────────────────────────────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  disabled={selectableCapped.length === 0}
                  onClick={onSelectAll}
                >
                  {allSelectableSelected
                    ? 'Deselect all'
                    : selectable.length > MAX_IMPORT_KEYS
                      ? `Select first ${MAX_IMPORT_KEYS}`
                      : 'Select all'}
                </button>
                <span style={{ color: color.muted }}>{selected.size} selected</span>
                <span style={{ flex: 1 }} />
                {/* m1: partial import — tell the user what landed and what didn't, then
                    let them re-import the skipped keys (not re-rendered as a blocking
                    error, since the import otherwise succeeded). */}
                {importResult ? (
                  <span style={{ color: color.muted, fontSize: fontSize.sm }}>
                    Imported {importResult.importedCount}
                    {importResult.skippedKeys.length > 0
                      ? `; skipped ${importResult.skippedKeys.length} (${importResult.skippedKeys.join(', ')})`
                      : ''}
                  </span>
                ) : null}
                <button type="button" disabled={importBusy} onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={selected.size === 0 || overSelectionCap || importBusy}
                  onClick={onImport}
                >
                  {importBusy ? 'Importing…' : 'Import'}
                </button>
              </div>
              {overSelectionCap ? (
                <span role="alert" style={{ color: color.errorText, fontSize: fontSize.sm }}>
                  At most {MAX_IMPORT_KEYS} issues per import
                </span>
              ) : null}
              {/* m2: route import errors through the same noKey/unauthorized/retry affordances
                  as fetch errors instead of a bare string. */}
              {importError ? (
                <JiraErrorNotice
                  error={importError}
                  onOpenSettings={openSettingsFromError}
                  onRetry={onImport}
                />
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
