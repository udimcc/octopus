# Rule: every modal/dialog follows the shared overlay contract

The Issues drawer (`src/renderer/src/components/IssuesDrawer.tsx`) stays mounted behind App-level
modals and hands focus/Escape to "the topmost open dialog". It finds that dialog with
`topmostModal()` = the LAST `[aria-modal="true"]` in DOM order. That is only correct while DOM
order equals paint order, so any new modal, dialog or overlay in `src/renderer/` must follow these
rules. Otherwise focus restore, Escape routing and shortcut suppression silently break.

## Requirements for a new dialog

- **Backdrop:** use `overlayStyle` from `src/renderer/src/style/tokens.ts` (`position: fixed`,
  shared `zIndex: 100`). Never give one overlay its own `zIndex`, and never add a stacking context
  (`transform`, `filter`, `opacity < 1`, `z-index` on a positioned ancestor, …) to `#root`, the
  sidebar or `<main>`.
- **Card:** `role="dialog"`, `aria-modal="true"` and `tabIndex={-1}`, so it can take focus when
  focus drops to `<body>`.
- **`onKeyDown` on the card calls `e.stopPropagation()` for every key**, then handles its own
  Escape. Without it, chords typed in the dialog (Ctrl+Shift+Arrow, Ctrl+Shift+W, …) reach the
  window-level shortcut listener (`useKeyboardShortcuts`) and act on the sessions behind it.
- **Dialogs opened from inside the Issues drawer** are portaled to `document.body`, which escapes
  the drawer's `transform` containing block.
- **No `backdrop-filter`, `filter` or blur** on overlays: the VDI host renders in software and
  stalls (see the New-Task modal history).

## Non-modal overlays and the drawer's ancestors

- **Drag ghosts** (the Board's dragged-card copy in `KanbanBoard.tsx`) are also portaled to
  `document.body`, but are not dialogs. They are `aria-hidden`, use `pointerEvents: 'none'` and
  have no `aria-modal`, so `topmostModal()` ignores them. They move by `transform` only.
- **Keep the drawer's ancestors non-scrollable.** App's workspace area uses `overflow: 'clip'`,
  not `'hidden'`. A `scrollIntoView` inside the sliding (transformed) drawer would otherwise
  scroll that ancestor sideways. Don't switch it back.

## When adding one

Add the dialog to the list in the `topmostModal()` doc comment in `IssuesDrawer.tsx`. Add a test
with a window `keydown` spy proving keys typed in it never reach the window listener (pattern:
`NewTaskModal.test.tsx`, `useKeyboardShortcuts.test.tsx`).
