# Octopus UI Enhancements - Design

**Date:** 2026-10-21
**Scope:** three independent renderer/packaging enhancements. No IPC, domain or persistence changes.

## 1. "+" session button next to the last tab

**Goal:** the add-session control sits immediately right of the last session tab, so a new tab
appears where the button was and the button shifts right (browser-tab-bar feel).

**Decisions**
- **Overflow:** when tabs overflow, the button stays visible at the right edge of the strip (sticky
  behavior). It never scrolls out of view.
- **Look:** a compact ghost "+" at tab height, with no teal fill and a hover highlight. When the
  task has **no sessions**, it shows the full label "+ Session".
- **Layout approach (chosen: shrinking list):** the scrollable tab list stops taking all free space
  (`flex: 1` becomes "shrink to content, capped at available width"). The button stays a sibling
  outside the scroll container, so it follows the tabs naturally and lands at the edge once the
  list hits its cap. This was preferred over putting the button inside the scroller with
  `position: sticky`, which would clip the multi-type dropdown menu (a dormant V2 seam) and needs
  an opaque background and extra scroll math.
- **Detach hit-test:** dropping a dragged tab "outside the bar" detaches it to a new window. That
  test currently measures the scroll list; it must measure the **whole tab bar**. Otherwise a drop
  in the now-empty space right of the tabs would wrongly detach.
- **Secondary windows:** the task-name label keeps its right alignment via an auto left margin.
- Unchanged: the click → `sessions.create` IPC flow, the multi-type dropdown, the disabled rules
  (task not ready / viewed elsewhere), the `new session` accessible name, the chevrons and the
  "…" jump menu.

## 2. Close button in the Issues drawer

**Goal:** a visible way to close the drawer besides the sidebar toggle and the shortcut.

**Decisions**
- A ✕ icon button at the **far left** of the drawer header, before "+ New Issue". Accessible
  name "close issues", tooltip "Close (Esc)".
- It reuses the store's dirty-guarded `toggleIssuesDrawer`, the same path as Escape and
  Alt+Shift+I. With unsaved edits it raises the existing "Discard changes?" prompt; focus
  restore on close works as it does today.
- It is a button, not a dialog, so the overlay rule's `topmostModal()` list is unaffected.
  While the drawer is closed it is `inert`, so the ✕ is unreachable.

## 3. Octopus app icon

**Current state:** no icon exists anywhere (`build/` is empty, no `icon` on `BrowserWindow`, no
favicon, no launcher entry), so Electron's default icon is used.

**Decisions**
- **Options:** 6 hand-drawn SVG cute octopuses, two each of kawaii/chibi, "multitasking mascot"
  (tentacles holding tiny terminals or git branches; a nod to parallel tasks) and flat minimal.
  Colors are mixed: app teal on dark, plus coral/purple. A gallery page previews each at 16, 32,
  64 and 256px on the dark theme.
- **Checkpoint:** the user picks the winner before any wiring. Unpicked options stay in
  `docs/icons/` for future reference.
- **Single source:** the chosen SVG lives in the renderer assets. A one-off script renders PNGs
  (512 for packaging/launcher, 256 for runtime) with **Electron offscreen**. No rasterizer
  dependency is added (none is available air-gapped). The PNGs are committed and re-rendered when
  the SVG changes.
- **Usage:**
  - Window/taskbar: every window (main, secondary, view) gets the icon via `createWindow`.
    It is imported as an electron-vite asset because only `out/**` is packaged.
  - Launcher: the release tarball carries the icon. `install.sh` installs it into the user hicolor
    icon theme and writes a `.desktop` entry (with a `StartupWMClass` verified against the real
    window class so taskbar grouping works). `uninstall.sh` removes both.
  - Sidebar: a small (~22px) decorative mascot next to the existing "Octopus - version" title.

## Testing strategy

- **Tab bar:** label at 0 vs ≥1 sessions; the button comes after the tab list in DOM order;
  disabled states; a drop in empty bar space reorders rather than detaches.
- **Drawer:** ✕ closes; a dirty draft shows the discard prompt and keeps the drawer open; focus
  is restored; inert when closed.
- **Icon:** `createWindow` passes an icon; the packaging PNG exists at 512×512.
- **Manual (VDI GUI):** overflow keeps "+" visible with working chevrons/"…" menu; secondary/view
  window label alignment; full install → launcher entry → uninstall cycle; taskbar icon and
  grouping. The install script stays manually tested.

## Possible follow-up

Note in `CLAUDE.md` that the renderer SVG is the icon's source of truth and that the render
script must be re-run after editing it.
