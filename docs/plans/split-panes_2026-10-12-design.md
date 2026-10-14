# Split Panes — Design

**Date:** 2026-10-12
**Status:** Approved (brainstorm)
**Approach:** A — renderer-owned layout tree, flat absolute-positioned panes, persist-only opaque blob

## Goal

Let the user see several sessions of the same task at once inside one window, tmux/xterm style, by
splitting the session area into a recursive tree of panes.

## Scope & decisions

| Topic | Decision |
|---|---|
| Motivation | See multiple sessions (2+) at once without tab switching. |
| What may share a split | Sessions of the **same task only**, within **one window**. The §3.7 sync model (switch task ⇒ every window switches) is unchanged. |
| Layout model | **Recursive binary tree** (tmux-like): each node is a leaf (one session) or a split (direction row/col, ratio, two children). |
| Tabs | **One tab bar per task** (unchanged). Tabs shown in a pane get a subtle "visible" marker. |
| "On screen" for §9.5 | **Only the focused pane.** A visible but unfocused pane is *not* on screen — it still raises the review dot and the state toast. |
| Persistence | **Persisted per task + window** across restart. |
| Creating a split | Configurable **keyboard chords** (create a **new terminal** next to the focused pane) and the **tab context menu** ("Split right / Split down" puts **that tab's existing session** next to the focused pane). No drag-to-split. |
| Closing a pane | **Unsplit only** — the session lives on as a hidden tab. Closing the *session* (× / close chord) kills it and collapses its pane. |
| Tab click / next-prev while split | A **hidden** tab replaces the focused pane's session. A tab already **visible** in another pane just moves focus there. The cross-window walk is unchanged. |
| Pane focus | **Mouse click** in a pane, and four **directional chords**. |
| Size limit | **Minimum pane size only** (about 20 cols × 5 rows); no hard pane-count cap. |
| Cross-window move | A split session moved to another window is removed from this window's layout and arrives **unsplit** (as a normal tab) in the target. |

## Architecture

### Layout model
- The `SplitNode` type lives in `shared/` because it crosses IPC, but only as an **opaque JSON blob**. The backend never interprets it.
- All tree logic is a **pure renderer module**: split, remove, replace, setRatio (clamped), neighbor-by-direction, toRects, prune, leaf listing, can-split (minimum size).
- Each window's store holds `layoutByTask[taskId]`. An absent entry means unsplit, which is exactly today's behavior.
- **The window's existing mark (`activeSessionByTask`) is the focused leaf.** This is the key simplification: `isSessionFocused`, the §9.5 review dot, the state toast, and the session shortcuts keep their current meaning. Only the focused pane is "on screen".

### Rendering (preserves §5.3 keep-alive)
- **Panes are never nested React components.** If a pane sat inside split containers, any restructure would change its React parent and remount its `TerminalPane`, destroying the xterm, its scrollback and its sink.
- Instead, `TaskView` keeps rendering every `SessionPane` **flat, keyed by session id**. A pure `toRects` maps the tree to absolute percentage boxes. Panes not in the layout stay hidden exactly as today.
- A separate divider overlay draws draggable gutters and changes split ratios.
- The focused pane gets a thin outline. A click in a pane focuses it (sets the mark and persists focus like a tab click).
- `TerminalPane`'s single `active` flag is split into **`visible`** (fit/resize, renderer tier / WebGL lease, scroll-intent capture and restore) and **`focused`** (keyboard focus).

### Data flow
- A user action updates `layoutByTask` in the window store.
- One store subscriber detects changed layouts and sends a debounced, fire-and-forget `layouts.save {windowId, taskId, layout | null}`. It also catches changes made by reducers, such as prunes on close or move.
- Main dispatches a **persist-only command** through the command loop: no bus event, the same pattern as `focusSession`.
- The command loop writes the row in the `split_layouts` table.
- On boot, `getState` returns this window's layouts. The renderer prunes them against the sessions it hosts. If the persisted mark is not a leaf, the first leaf becomes the mark.

### Async split-with-new-terminal
- A split chord records a `pendingSplit` intent `{taskId, anchorSessionId, dir}` in the window store, then calls `sessions.create` with this window's id.
- The next `sessionCreated` of that task **hosted in this window** consumes the intent: it splits the anchor leaf with the new session and focuses it.
- No backend correlation id is needed.

### Lifecycle reconciliation
- **Session close or move-out** → the leaf is removed, a split left with one child collapses, and the mark moves to the sibling leaf. A tree reduced to one leaf becomes unsplit.
- **Task delete / window close** → layout rows are removed by FK cascade. Sessions returned to main arrive unsplit.
- **Exited session** → stays in its pane (no auto-collapse), like an exited tab today.

## Implementation overview (by layer)

| Layer | Change |
|---|---|
| `shared/` | Split-layout type, a fire-and-forget layout-save IPC channel, layouts in the hydrate DTO, six new chord settings. |
| `adapters/persistence` | Forward-only migration v8: `split_layouts` (task id → tasks cascade, window id → windows cascade, layout text, primary key task + window). Save/delete and load-by-window. |
| `ports/` + `application/` | Port methods; a persist-only save-split-layout command and use case. |
| `main/` + `preload/` | IPC handler dispatching to the loop; hydrate includes this window's layouts; preload bridge method. |
| `renderer/store` | Pure layout module; `layoutByTask`, `pendingSplit`; reducers for create/close/move/hydrate; the debounced save subscriber. |
| `renderer/components` | `TaskView` flat rect rendering; `SessionPane` rect/visible/focused and click-to-focus; new divider overlay. |
| `TerminalPane` | `active` split into `visible` + `focused`; the key guard also drops the six new chords. |
| Tab bar | Visible-in-split marker; context menu "Split right / Split down / Close pane"; split-aware click semantics. |
| Shortcuts / Settings | Split chords (new terminal), directional focus chords, split-aware next/prev; Settings fields and conflict checks. |

**Default chords:** split right `Ctrl+Shift+E`, split down `Ctrl+Shift+O`, focus pane `Ctrl+Shift+H/J/K/L` (changed in review from `Ctrl+Alt+Shift+Arrow`, which GNOME grabs for move-to-workspace).
These were chosen not to collide with the existing defaults or the debug chord, and to avoid stealing `Alt+Arrow`, which readline and emacs use for word movement. All of them carry Ctrl+Shift, so the existing blanket xterm drop also covers them.

**No backend PTY, daemon, or protocol changes.** Each session is still shown in exactly one pane of one window, and each pane fits and resizes its own PTY.

## Testing strategy

- **Pure layout module (bulk of coverage):** every tree operation; rect tiling with no overlap across nested row/col; directional neighbor including boundaries; prune of unknown ids, single-child collapse, one-leaf → unsplit, garbage → unsplit; minimum-size refusal.
- **Store:** `pendingSplit` consumed only by a same-task creation hosted in this window; close and move-out prune and move the mark; hydrate prunes and fixes the mark; `isSessionFocused` true only for the focused leaf (a visible unfocused pane still raises review); the save subscriber fires after reducer-driven prunes.
- **Persistence / application:** v7→v8 migration, CRUD, cascades on task delete and window delete; the use case persists only and emits no event.
- **Rendering — hard acceptance criterion:** split, unsplit, replace, and sibling close never remount or dispose a `TerminalPane`.
- **TerminalPane:** visible-but-unfocused fits without taking focus; the key guard drops the new chords.
- **Tab bar / shortcuts / settings:** context-menu items, hidden-tab replace, visible-tab focus, the new chords and conflict detection.
- **Edge cases:** closing the focused pane's session; task switch while split; exited session in a pane; window close with a layout; minimum-size refusal in a tiny window.
- **Manual:** DOM-renderer cost on the VDI host with four visible panes.

## Risks

- **Terminal remount on restructure.** Mitigated by the flat render rule and the never-remount test.
- **VDI (software GL) cost.** Several visible panes on the DOM renderer repaint at once. Verify manually; the minimum pane size bounds the extreme.
- **State-logic drift.** `.claude/rules/claude-state-prd.md` applies, so run the co-located tests and the PRD-conformance sub-agent.

## Documentation to update with the implementation

- `DESIGN.md`: a new "Split panes" subsection under §5; a §5.3 note on the flat render rule; a §3.7 note that the mark is the focused pane.
- `CLAUDE_STATE_PRD.md`: clarify that a visible but unfocused split pane is not "on screen".
- `TASKS.md` entries and a `CHANGELOG.md` entry.
