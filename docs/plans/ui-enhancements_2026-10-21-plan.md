# Octopus UI Enhancements - Plan

**Feature**: "+" new-session button right after the last tab, a ✕ close button in the Issues
drawer, and an octopus app icon (windows, Linux launcher, sidebar).

## Wave 1 (parallel)
### [x] Subject 1: "+" button follows the last tab

- [x] `src/renderer/src/components/SessionTabBar.tsx` (~line 577): tab list `flex: 1` → `flex: '0 1 auto'`
- [x] `insideBar` (~line 206): measure the outer `.session-tabs` bar via a new ref instead of `scrollRef`; update the header doc note (~line 45)
- [x] Secondary-window task-name label (~line 764): `marginLeft: 'auto'`
- [x] `src/renderer/src/components/NewSessionDropdown.tsx`: "+ Session" label at 0 sessions, otherwise a compact ghost "+"; keep `aria-label="new session"`, the multi-type dropdown and the disabled logic
- [x] `src/renderer/src/style/globals.css`: ghost tab-button class (no fill, hover highlight, tab height)

### [x] Subject 2: Issues drawer ✕

- [x] `src/renderer/src/components/IssuesDrawer.tsx` header row (~line 295): ✕ button before "+ New Issue", `aria-label="close issues"`, `title="Close (Esc)"`, `onClick={toggleIssuesDrawer}`
- [x] Not a dialog: leave the `topmostModal()` doc list unchanged

### [x] Subject 3a: Icon options gallery

- [x] Mascot SVGs under `docs/icons/` (kawaii and flat styles dropped after review; 7 rounds converged on a cyan octopus with black eyes and no mouth)
- [x] `docs/icons/gallery.html` previewing each at 16/32/64/256px on dark and light backgrounds

## [x] CHECKPOINT: user picked `octopus-mascot-19` (darker mascot-10, juggling a terminal, a tab and a git branch); unpicked options stay in `docs/icons/`

## Wave 2 (depends on checkpoint)
### [x] Subject 3b: Single-source asset and PNG rendering

- [x] Copy the chosen SVG (`docs/icons/octopus-mascot-19.svg`) to `src/renderer/src/assets/octopus.svg`
- [x] New `scripts/render-icon.mjs`: Electron offscreen render → `build/icon.png` (512) and `resources/icon.png` (256); no new deps
- [x] `render:icon` npm script; commit both PNGs

## Wave 3 (parallel, depends on Wave 2)
### [x] Subject 3c: Window icon

- [x] `src/main/window.ts` `createWindow` (~line 95): import `resources/icon.png?asset`, pass `icon` to `new BrowserWindow` (covers all windows)

### [x] Subject 3d: Linux desktop integration

- [x] `scripts/release.mjs` (~line 90): stage `build/icon.png` as `icon.png` next to `install.sh`
- [x] `install.sh`: install the icon to `~/.local/share/icons/hicolor/512x512/apps/octopus.png`; write `~/.local/share/applications/octopus.desktop` (`Exec=<launcher>`, `Icon=octopus`, `StartupWMClass` verified via `xprop WM_CLASS`)
- [x] `uninstall.sh`: remove the `.desktop` file and the icon

### [x] Subject 3e: Sidebar mascot

- [x] `src/renderer/src/components/ProgressPanel.tsx` (~line 179): 22px decorative `octopus.svg` (`alt=""`) next to the "Octopus - version" `<h1>`

## Testing

- [x] `SessionTabBar.test.tsx`: "+ Session" at 0 sessions, "+" at ≥1; button after the tablist in DOM order; disabled states; drop in empty bar space → reorder, not detach
- [x] `IssuesDrawer.test.tsx`: ✕ closes; dirty draft → discard prompt, drawer stays open; focus restored; inert when closed
- [x] `src/main/window.test.ts`: `icon` passed in `createWindow` (static source check — see test file header comment; a live `createWindow()` invocation needs a full `BrowserWindow` class + `AppContext` beyond this file's minimal electron mock); `build/icon.png` exists and is 512×512, `resources/icon.png` is 256×256
- [ ] Manual: overflow keeps "+" at the right edge; task label in secondary/view windows; install/uninstall `.desktop` cycle; taskbar icon and grouping
- [x] `npm run lint`, `npm run typecheck`, `npm run test` pass

## Acceptance Criteria
- "+" sits right after the last tab and stays at the right edge when tabs overflow; it reads "+ Session" when the task has no sessions
- Dropping a tab in empty bar space never detaches it
- The drawer ✕ behaves exactly like Escape (dirty guard, focus restore)
- The mascot icon options plus the gallery are kept in `docs/icons/`; the chosen icon is a single source SVG with committed rendered PNGs
- All windows, the Linux launcher and the taskbar show the icon; uninstall leaves nothing behind
- The sidebar header shows the mascot
