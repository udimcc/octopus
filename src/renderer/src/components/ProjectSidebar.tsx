/**
 * The project sidebar in the New-Task modal (DESIGN §5.4). A pure, controlled,
 * presentational component — no IPC calls happen here. The modal owns fetching
 * `projects.list` and dispatching `projects.add` / `projects.remove` /
 * `projects.setDefaultBranch`; this component only renders what it's given and
 * reports user intent back through its callback props.
 *
 * Row label is the repo basename (`repoBasename`, shared with the Progress
 * panel's repo grouping, `store/group-tasks.ts`); the full path is the row's
 * `title`. The default branch is edited inline with the existing
 * `EditableLabel` (double-click to edit, Enter commits, Escape/blur cancels).
 * A row with no default branch has nothing to double-click on — `EditableLabel`
 * just renders an empty `<span>` — so a CSS rule (`.default-branch-slot`,
 * `globals.css`) paints a "no default" placeholder over that empty span via
 * `:empty::after`. The placeholder disappears the moment editing starts
 * (the span becomes an `<input>`), so it never collides with the real draft.
 *
 * Delete is a two-step affordance rather than a separate dialog: the 🗑
 * icon-button switches that row into an in-row "Remove? ✓ ✗" confirm (at most
 * one row confirms at a time), and is disabled with a tooltip while the
 * project still has tasks (`taskCount > 0` — the main process re-checks and
 * can still reject a stale click; the modal surfaces that via `error`).
 *
 * Focus restore: every mutation flips `busy`, which disables the focused
 * control (or, on a successful remove, unmounts its row) and drops focus to
 * `<body>` — where Escape no longer reaches the dialog's handler. Each action
 * therefore records where focus belongs ("+ Add project" after add/remove, the
 * row after a default-branch edit), and that target is focused once `busy`
 * clears, but only if focus is still lost.
 */

import { useEffect, useRef, useState } from 'react'
import { EditableLabel } from './EditableLabel'
import { repoBasename } from '../store/group-tasks'
import { color, fontSize } from '../style/tokens'
import type { ProjectListItemDTO } from '../../../shared/dto'

export interface ProjectSidebarProps {
  readonly projects: readonly ProjectListItemDTO[]
  readonly selectedPath?: string
  /** Disables every control in the sidebar (a mutation or create is in flight). */
  readonly busy: boolean
  /** True while the initial project list fetch is in flight. */
  readonly loading?: boolean
  readonly error?: string | null
  readonly onSelect: (path: string) => void
  readonly onAdd: () => void
  readonly onRemove: (path: string) => void
  readonly onSetDefaultBranch: (path: string, branch: string) => void
}

export function ProjectSidebar({
  projects,
  selectedPath,
  busy,
  loading,
  error,
  onSelect,
  onAdd,
  onRemove,
  onSetDefaultBranch
}: ProjectSidebarProps): React.JSX.Element {
  // At most one row is in the "Remove? ✓ ✗" confirm at a time.
  const [confirmingPath, setConfirmingPath] = useState<string | null>(null)
  // Row elements keyed by project path, so focus can return to the row that
  // opened the confirm after it's cancelled or confirmed.
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  // The confirm's "cancel" (✗) button, focused as soon as the confirm appears so
  // Escape/Enter inside the dialog keep working instead of falling to <body>.
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const addButtonRef = useRef<HTMLButtonElement | null>(null)
  // Where focus goes once the in-flight mutation settles (see the header).
  const refocusRef = useRef<(() => HTMLElement | null | undefined) | null>(null)

  useEffect(() => {
    if (confirmingPath) cancelButtonRef.current?.focus()
  }, [confirmingPath])

  useEffect(() => {
    if (busy) return
    const target = refocusRef.current
    refocusRef.current = null
    const active = document.activeElement
    if (target && (active === null || active === document.body)) target()?.focus()
  }, [busy])

  const closeConfirm = (path: string): void => {
    setConfirmingPath(null)
    rowRefs.current.get(path)?.focus()
  }

  return (
    <div
      style={{
        width: 200,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: `1px solid ${color.border}`
      }}
    >
      <ul
        role="listbox"
        aria-label="Projects"
        style={{
          margin: 0,
          padding: 0,
          overflowY: 'auto',
          flex: 1,
          maxHeight: 320,
          listStyle: 'none'
        }}
      >
        {projects.length === 0 ? (
          <li
            role="presentation"
            style={{
              listStyle: 'none',
              padding: '8px 10px',
              color: color.muted,
              fontSize: fontSize.sm
            }}
          >
            {loading ? 'Loading…' : 'No projects yet'}
          </li>
        ) : null}
        {projects.map((project) => {
          const name = repoBasename(project.path)
          const selected = project.path === selectedPath
          const confirming = confirmingPath === project.path

          return (
            <li key={project.path} role="presentation" style={{ listStyle: 'none' }}>
              <div
                ref={(el) => {
                  if (el) rowRefs.current.set(project.path, el)
                  else rowRefs.current.delete(project.path)
                }}
                role="option"
                aria-selected={selected}
                aria-label={name}
                title={project.path}
                tabIndex={0}
                onClick={() => {
                  if (!busy) onSelect(project.path)
                }}
                onKeyDown={(e) => {
                  // Only act when the row itself is the event target — not a
                  // bubbled keydown from the nested 🗑/✓/✗ buttons or the
                  // default-branch edit input.
                  if (e.target !== e.currentTarget) return
                  if (!busy && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    e.stopPropagation()
                    onSelect(project.path)
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '6px 6px 6px 8px',
                  cursor: busy ? 'default' : 'pointer',
                  background: selected ? color.bgSelected : 'transparent',
                  color: selected ? color.text : color.textSecondary,
                  boxShadow: selected ? `inset 2px 0 0 ${color.accent}` : 'none',
                  boxSizing: 'border-box'
                }}
              >
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <div
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {name}
                  </div>
                  <div
                    className="default-branch-slot"
                    style={{ pointerEvents: busy ? 'none' : 'auto', fontSize: fontSize.sm }}
                  >
                    <EditableLabel
                      value={project.defaultBranch ?? ''}
                      onCommit={(next) => {
                        refocusRef.current = () => rowRefs.current.get(project.path)
                        onSetDefaultBranch(project.path, next)
                      }}
                      editAriaLabel={`edit default branch for ${name}`}
                      style={{ display: 'inline-block', color: color.muted, width: '100%' }}
                    />
                  </div>
                </div>

                {confirming ? (
                  <span
                    style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: fontSize.sm }}
                    onKeyDown={(e) => {
                      // Cancel the confirm instead of letting Escape bubble up
                      // and close the whole modal.
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        closeConfirm(project.path)
                      }
                    }}
                  >
                    <span style={{ color: color.muted, whiteSpace: 'nowrap' }}>Remove?</span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`confirm remove project ${name}`}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmingPath(null)
                        // The row unmounts on success, so land on Add instead.
                        refocusRef.current = () => addButtonRef.current
                        addButtonRef.current?.focus()
                        onRemove(project.path)
                      }}
                    >
                      ✓
                    </button>
                    <button
                      ref={cancelButtonRef}
                      type="button"
                      className="icon-button"
                      aria-label={`cancel remove project ${name}`}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeConfirm(project.path)
                      }}
                    >
                      ✗
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`remove project ${name}`}
                    disabled={busy || project.taskCount > 0}
                    title={
                      project.taskCount > 0
                        ? `In use by ${project.taskCount} task${project.taskCount === 1 ? '' : 's'}`
                        : undefined
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmingPath(project.path)
                    }}
                  >
                    🗑
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {error ? (
        <p
          role="alert"
          style={{ margin: '0 8px 8px', color: color.errorText, fontSize: fontSize.sm }}
        >
          {error}
        </p>
      ) : null}

      <button
        ref={addButtonRef}
        type="button"
        onClick={() => {
          refocusRef.current = () => addButtonRef.current
          onAdd()
        }}
        disabled={busy}
        style={{ margin: 8 }}
      >
        + Add project
      </button>
    </div>
  )
}
