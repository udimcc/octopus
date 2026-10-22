/**
 * The Issues drawer (PRD "Issues" → "Issues window"; DESIGN §13.5). Always mounted
 * as an absolutely-positioned sibling of the session area, sliding in from the right
 * via a CSS `transform` only (`.issues-drawer` in globals.css) — no backdrop, blur,
 * or opacity fade over a large surface: on the VMware VDI host (software SwiftShader
 * rendering, no GPU) that is a visible multi-second stall, the same reason the
 * New-Task modal's backdrop blur was dropped.
 *
 * Header row (DESIGN §13.5): **+ New Issue** and **Fetch from Jira** (§13.7, opens the portaled
 * `JiraImportModal`), then `[List] [Board]` tabs —
 * `role="tablist"`/`role="tab"`/`aria-selected`, the same lightweight pattern as
 * `NewTaskModal`'s source tabs (unselected = plain button, selected = `btn-primary`) —
 * reading/writing the store's `issuesDrawerTab` / `setIssuesDrawerTab` (renderer-only
 * view state, never persisted, never part of the hydrated app state). **+ New Issue**
 * sits on the left, before the tabs (set apart by a gap), and calls the store's
 * `startNewIssue` directly, same as before the Board tab existed, including its dirty-guard (`discardPrompt`): it works identically
 * on both tabs since it's hoisted here rather than living inside `IssueList`. Left as a
 * plain (unstyled) button, same as the tabs' own unselected state, so it's the same
 * height as them and reads as a distinct action rather than a third, always-on tab.
 *
 * Below the header: `IssueList` (List tab) or `KanbanBoard` (Board tab) on the left,
 * each wrapped in an identical `role="tabpanel"` div (`aria-label` "List"/"Board",
 * `flex: 1; minWidth: 0`, the single `borderRight` that separates it from `IssueDetail`)
 * — only one is mounted at a time, swapped on `issuesDrawerTab` — and `IssueDetail` on
 * the right, mounted UNCONDITIONALLY across both tabs so its local edit-form state
 * (and any unsaved edit) survives a tab switch untouched; switching tabs only changes
 * `issuesDrawerTab`, never `selectedIssueId`/`issueDraft`/`issueEditDirty`, so it can
 * never raise `discardPrompt`. `IssueDetail` takes a fixed share of the drawer's width
 * (`ISSUE_VIEW_WIDTH_SHARE`, defined there) identical on both tabs; the tabpanel wrapper
 * takes the rest via `flex: 1` with `minWidth: 0` (so the Board's own horizontal
 * scroll can actually kick in instead of widening the row). `onCreateTaskFromIssue`/
 * `onDeleteBoundTask` are passed straight through to `IssueDetail` — they are wired by
 * the caller (`App.tsx`); this component and `IssueDetail` are agnostic to what they
 * actually do.
 *
 * ESCAPE: handled HERE (with `stopPropagation`) so an Esc meant for the drawer never
 * also reaches xterm underneath. It routes through the SAME guarded
 * `toggleIssuesDrawer` the Issues button and shortcut use, so a dirty edit raises
 * `discardPrompt` instead of closing. While another `[aria-modal="true"]` dialog is
 * open (App-level or one of the drawer's own), that dialog owns Escape and this handler
 * does nothing. `DiscardChangesPrompt` handles its own Esc ("Keep editing"); the
 * `discardPrompt` branch here is only a backstop if focus is on the drawer itself.
 * When focus has left the drawer's DOM subtree entirely, `useKeyboardShortcuts` maps
 * Escape to the same `toggleIssuesDrawer()` at the window level; `stopPropagation`
 * here keeps the two from double-firing.
 *
 * KEYS: every other key from a non-editable target keeps bubbling to the window-level
 * shortcut listener on purpose — the drawer is a persistent sibling panel, not a true
 * modal, so task/session switching still works while focus is inside it. From an
 * editable control (name input, description textarea, selects, …) every key except the
 * configured `issuesKey` chord is stopped: otherwise a chord like Ctrl+Shift+ArrowRight
 * (session cycle) steals word-selection and silently switches session/task behind the
 * drawer. `issuesKey` is let through so it can close the drawer from a field.
 *
 * FOCUS: opening moves focus onto the drawer root (its content is dynamic, so there is
 * no single stable control to target); closing restores focus to whatever had it
 * before opening, falling back to the active terminal, then the Issues button. While
 * open, a `document` `focusout` listener catches focus dropping to `<body>` (a busy
 * control disabling, an edit ending, a dialog's autofocused button unmounting) and
 * hands it to the topmost open dialog, else the drawer root, so Escape always has a
 * target. The listener is on `document`, not the root, because the nested dialogs are
 * portaled to `document.body` (to escape the drawer's `transform` containing block for
 * their `position: fixed` backdrop) and their `focusout` never passes through the root.
 *
 * FOCUS vs. APP-LEVEL MODALS: the drawer stays mounted (and un-`inert`) behind an
 * App-level modal opened while it's open — e.g. "Create task" from `IssueDetail` opens
 * `NewTaskModal` as a sibling, and the sidebar's New Task/gear/delete flows stay
 * reachable by mouse. Every dialog card is `role="dialog" aria-modal="true"` with
 * `tabIndex={-1}` so it can take focus; the open, close-restore and focus-retention
 * paths all defer to an open dialog instead of pulling focus onto the drawer root or
 * into the workspace under it.
 *
 * `aria-hidden` plus the native `inert` IDL property (not present in this project's
 * `@types/react` 18.3, so set imperatively via the DOM) keep a closed-but-mounted
 * drawer out of the tab order and the accessibility tree.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { useStore, activeSessionInWindow } from '../store/store'
import { IssueList } from './IssueList'
import { IssueDetail } from './IssueDetail'
import { KanbanBoard } from './KanbanBoard'
import { JiraImportModal } from './JiraImportModal'
import { DiscardChangesPrompt } from './DiscardChangesPrompt'
import { color } from '../style/tokens'
import { focusTerminal } from '../terminal/terminal-focus'
import { matchesChord } from '../keybindings/chords'

/**
 * The topmost currently-open `[aria-modal="true"]` dialog, if any — App-level
 * (`NewTaskModal`, `SettingsModal`, `DeleteTaskConfirm`, `CreateViewConfirm` —
 * window-view feature) or one of the drawer's own
 * (`DiscardChangesPrompt`, `BoundDeleteDialog`, `LinkTaskPicker`, `IssueDetail`'s
 * simple delete confirm, `JiraImportModal`). "Last in document order" is topmost because every overlay
 * shares `overlayStyle` (`position: fixed`, the same `zIndex`) and nothing around the
 * inline ones (`#root`, the sidebar, `<main>`) creates a stacking context, so paint
 * order is DOM order (body-level portals always follow `#root`). Giving one overlay its own `zIndex`, or
 * a stacking context to the sidebar/main, would break this.
 */
function topmostModal(): HTMLElement | null {
  const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]')
  return modals.length > 0 ? modals[modals.length - 1] : null
}

export interface IssuesDrawerProps {
  /** Open the task-creation flow prefilled from this issue. */
  readonly onCreateTaskFromIssue: (issueId: string) => void
  /** Delete the task bound to an issue, optionally also deleting the issue. */
  readonly onDeleteBoundTask: (taskId: string, alsoDeleteIssue: boolean) => void
}

export const IssuesDrawer = memo(function IssuesDrawer({
  onCreateTaskFromIssue,
  onDeleteBoundTask
}: IssuesDrawerProps): React.JSX.Element {
  const open = useStore((s) => s.issuesDrawerOpen)
  const tab = useStore((s) => s.issuesDrawerTab)
  const setIssuesDrawerTab = useStore((s) => s.setIssuesDrawerTab)
  const startNewIssue = useStore((s) => s.startNewIssue)
  // Local, unpersisted: whether the Jira Import modal is open (DESIGN §13.7).
  const [jiraImportOpen, setJiraImportOpen] = useState(false)
  const discardPrompt = useStore((s) => s.discardPrompt)
  const toggleIssuesDrawer = useStore((s) => s.toggleIssuesDrawer)
  const confirmDiscard = useStore((s) => s.confirmDiscard)
  const cancelDiscard = useStore((s) => s.cancelDiscard)
  // Read the same way `useKeyboardShortcuts` does, so the one chord that's allowed
  // through from an editable field always matches what the window-level
  // listener itself treats as the Issues shortcut.
  const issuesKey = useStore((s) => s.settings.issuesKey)

  const rootRef = useRef<HTMLDivElement>(null)
  // The element focused right before the drawer opened; restored when it closes.
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // `inert` is not in @types/react 18.3 — reflect it onto the DOM node directly.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    ;(el as HTMLElement & { inert: boolean }).inert = !open
  }, [open])

  useEffect(() => {
    if (open) {
      previouslyFocused.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      // Don't steal focus from an open modal (e.g. the drawer toggled open by
      // shortcut or a secondary window's relay while `NewTaskModal` is up). Still
      // record `previouslyFocused`, so closing later runs the terminal/button
      // fallback even if it was `<body>`.
      if (!topmostModal()) rootRef.current?.focus({ preventScroll: true })
      return
    }
    const saved = previouslyFocused.current
    previouslyFocused.current = null
    if (!saved) return
    // Deferred to a macrotask: App.tsx's effect that lifts `inert` off the
    // workspace wrapper while this drawer closes belongs to an ANCESTOR
    // component, and React fires a child's effects before its parent's within
    // the same commit — so right now the workspace may still be `inert`, and
    // focusing into an inert subtree is a silent no-op. By the time a
    // `setTimeout` macrotask runs, both effects for this commit have already
    // applied, so the target is actually focusable. Cleared if the drawer reopens
    // (or unmounts) before it runs: that render owns focus now.
    const timer = setTimeout(() => {
      // A modal still open over the now-closed drawer (e.g. `NewTaskModal` opened
      // from `IssueDetail`) keeps focus rather than yielding it to the
      // terminal/toggle button underneath; if focus has dropped to `<body>`, hand it
      // to that modal so Escape still reaches it.
      const modal = topmostModal()
      if (modal) {
        const active = document.activeElement
        if (active === null || active === document.body) modal.focus({ preventScroll: true })
        return
      }
      // Fall back to the on-screen terminal, then to the Issues toggle button, so
      // focus never lands on `<body>` with nothing visibly focused.
      const fallback = (): void => {
        const data = useStore.getState()
        const sid = data.activeTaskId
          ? activeSessionInWindow(data, data.activeTaskId, data.windowId)
          : undefined
        if (sid) {
          focusTerminal(sid)
          return
        }
        document.getElementById('issues-drawer-toggle')?.focus({ preventScroll: true })
      }
      // `document.body` means nothing was actually focused when the drawer opened
      // — not a real saved target, so go straight to the fallback instead
      // of calling the no-op `document.body.focus()`.
      if (saved !== document.body && saved.isConnected && !saved.closest('[inert]')) {
        saved.focus({ preventScroll: true })
        // Confirm focus actually landed: a task/session switch while the
        // drawer was open can leave `saved` (the OLD active pane's xterm textarea)
        // still connected and un-inert, but hidden under `visibility: hidden`
        // beneath the now-active pane — `.focus()` on it silently no-ops. Only
        // trust the call if it actually worked; otherwise fall through to the
        // terminal/button fallback below (which prefers the now-active terminal,
        // the right target since `saved` was itself part of the workspace).
        if (document.activeElement === saved) return
      }
      fallback()
    }, 0)
    return () => clearTimeout(timer)
  }, [open])

  // Keep focus (and so Escape) somewhere live while the drawer is open: whenever it
  // drops to `<body>` (see the header's FOCUS section), hand it to the topmost open
  // dialog — never the drawer root BEHIND that dialog — else the drawer root.
  // Deferred a tick so the newly-focused element, if any, has actually landed (a
  // focusout fires before the browser settles on its next focus target). Attached to
  // `document` because the nested dialogs are portaled to `document.body`.
  useEffect(() => {
    if (!open) return
    // Only the latest pending check matters (each reads `activeElement` when it
    // runs); cleared on close/unmount so it can't act on a drawer that's gone.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onFocusOut = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const active = document.activeElement
        if (active === null || active === document.body) {
          const modal = topmostModal()
          if (modal) {
            modal.focus({ preventScroll: true })
          } else {
            rootRef.current?.focus({ preventScroll: true })
          }
        }
      }, 0)
    }
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusout', onFocusOut)
      clearTimeout(timer)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className="issues-drawer"
      role="dialog"
      aria-label="Issues"
      aria-hidden={!open}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Another open dialog (App-level or the drawer's own) owns Escape: do
          // nothing, so the drawer doesn't close or raise `discardPrompt` behind it.
          // `DiscardChangesPrompt` is the exception, handled by the branch below.
          // Each dialog's own `onKeyDown` normally stops Esc first; this is a
          // backstop for focus sitting on the drawer root while a dialog is open.
          if (!discardPrompt && document.querySelector('[aria-modal="true"]')) {
            return
          }
          // Keep Esc from ever reaching xterm (or anything else) beneath the
          // drawer, and from also being handled a second time by the window-level
          // fallback (`useKeyboardShortcuts`) — `stopPropagation` here also
          // stops the underlying native event, so that fallback never sees it.
          e.stopPropagation()
          if (discardPrompt) {
            // Esc while the discard prompt is up but focus is outside it: same as the
            // prompt's own "Keep editing".
            cancelDiscard()
            return
          }
          toggleIssuesDrawer()
          return
        }
        // Other keys: stopped from editable controls except `issuesKey`, bubbled
        // otherwise (see the header's KEYS section).
        const target = e.target
        const editable =
          target instanceof HTMLElement &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable)
        if (editable && !matchesChord(e.nativeEvent, issuesKey)) {
          e.stopPropagation()
        }
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        background: color.bgSurface,
        borderLeft: `1px solid ${color.border}`,
        transform: open ? 'translateX(0)' : 'translateX(100%)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          padding: '8px 12px',
          borderBottom: `1px solid ${color.borderSubtle}`
        }}
      >
        <button
          type="button"
          className="icon-button"
          aria-label="close issues"
          title="Close (Esc)"
          onClick={toggleIssuesDrawer}
        >
          ✕
        </button>
        <button type="button" style={{ marginLeft: 12 }} onClick={startNewIssue}>
          + New Issue
        </button>
        <button type="button" style={{ marginLeft: 8 }} onClick={() => setJiraImportOpen(true)}>
          Fetch from Jira
        </button>
        <div
          role="tablist"
          aria-label="Issues view"
          style={{ display: 'flex', gap: 6, marginLeft: 24 }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'list'}
            className={tab === 'list' ? 'btn-primary' : undefined}
            onClick={() => setIssuesDrawerTab('list')}
          >
            List
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'board'}
            className={tab === 'board' ? 'btn-primary' : undefined}
            onClick={() => setIssuesDrawerTab('board')}
          >
            Board
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          role="tabpanel"
          aria-label={tab === 'list' ? 'List' : 'Board'}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            borderRight: `1px solid ${color.border}`
          }}
        >
          {tab === 'list' ? <IssueList /> : <KanbanBoard />}
        </div>
        <IssueDetail
          onCreateTaskFromIssue={onCreateTaskFromIssue}
          onDeleteBoundTask={onDeleteBoundTask}
        />
      </div>

      {jiraImportOpen ? <JiraImportModal onClose={() => setJiraImportOpen(false)} /> : null}
      {discardPrompt ? (
        <DiscardChangesPrompt onDiscard={confirmDiscard} onKeepEditing={cancelDiscard} />
      ) : null}
    </div>
  )
})
