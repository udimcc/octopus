# Project Octopus — Technical Design Document

> **Status:** Draft for review · **Companion to:** [`PRD.md`](./PRD.md)
> This document turns the product requirements into an implementable architecture. It defines the
> domain model, the layering, the technology stack, the process/PTY backend, the session-state-detection
> subsystem, and a version-by-version build plan with the seams that keep future work additive.

---

## 1. Overview

Project Octopus is a desktop IDE for running **multiple development tasks in parallel**. Each **task** owns
an isolated git **worktree** and groups one or more **sessions** (interactive terminals today; a Jenkins
pipeline viewer and more later). A left-hand **progress window** lists tasks and their aggregate status; the
right-hand **task window** shows the active task's sessions as tabs. Switching tasks swaps the visible
sessions while **all sessions keep running in the background**.

### 1.1 Design goals

1. **Parallelism without loss** — sessions of non-active tasks keep running and retain scrollback.
2. **A small, stable domain surrounded by pluggable edges** — the OS (git scripts, PTYs), the UI framework,
   and external integrations (Jenkins) are all volatile; the core is not.
3. **Additive versioning** — V1 ships without painting into a corner; V2 (state) and V3 (Jenkins) add
   *implementations* behind interfaces defined in V1, not rewrites.
4. **Safety of destructive operations** — worktree create/delete run user scripts guarded by validation,
   containment checks, and strict teardown ordering.

### 1.2 Resolved ambiguities & key decisions

| Item | Resolution | Where decided |
|---|---|---|
| PRD line 39 tags Jenkins "Version 2+", but §Versioning says V3 | **Jenkins is V3.** V2 is *state only*. | §10 |
| Desktop runtime / UI stack (was open) | **Electron + React + TypeScript.** | §4 |
| Quit semantics (was open) | **Persist metadata + gracefully terminate processes; do not resurrect live process state.** Reconcile worktrees on startup. | §7, §8 |
| PTY hosting: in-process vs daemon vs tmux | **V1: node-pty in-process behind a `SessionManager` port.** Durable backend (daemon or tmux) is a V2+ migration with the same message protocol. | §6.2 |
| Task-state aggregation rule | **Worst-status-wins:** `Blocked > Working > Waiting > Unknown`. | §3.4, §9.3 |
| Worktree provisioning | **Repo-local script if present, else native git.** If `<repoDir>/create_worktree.sh` (resp. `delete_worktree.sh`) exists, Octopus runs it (script owns the location); otherwise Octopus provisions the worktree itself via `git worktree`. Detected **per task** on each create/delete. | §6.4, §12.4 |
| Worktree location | **Octopus-owned by default**, under a configurable base dir `worktree.location` (default `~/octopus_repos/`). A repo-local create script may return any location instead; Octopus stores the path verbatim. `repo_root` stored per task, so multi-repo works with no special support. | §6.3, §6.4, §12.4 |
| State-signal injection (OSC 133 + Claude hooks) | **Opt-out auto-injection** (rcfile sources user's rc; `.claude/settings.json` merged, never clobbered). Lands in V2. | §12.1 |
| Task-creation inputs | **Modal collects name, repo directory (native picker), source branch, new branch** (new-branch prefilled with a slug). All are passed to native git / the repo-local create script. | §5.4, §12.3 |
| Single vs multiple windows | **Multi-window, V1.5.** The **main** window owns the progress panel; **secondary** windows are session-only. All windows sync on the single `activeTaskId` (switch a task → sessions switch everywhere). Session→window is an opaque `windowId` on `Session` (default `MAIN_WINDOW_ID`); pixel bounds live in persistence only, never the domain. Windows + session assignments are restored on relaunch. | §3.7, §5.6, §6.7, §10 |

---

## 2. Architecture at a Glance

```
┌───────────────────────────────────────────────────────────────────────────┐
│ MAIN RENDERER (React)          │  SECONDARY RENDERER* (V1.5, one per window) │
│   ProgressPanel (tasks, icons, │    SecondaryWorkspace → SessionPane*        │
│     New/Delete/New Window)     │      (sessions where windowId == thisWindow)│
│   TaskWorkspace → TaskView* →  │    (no progress panel; session-only)        │
│     SessionTabBar → SessionPane*│                                             │
│   Zustand store (per renderer); xterm.js instances in refs; windowId/role    │
└───────────────▲───────────────────────────────────────────── commands ▼────┘
                │ events (ptyData, lifecycle, stateChanged)   │
        ┌───────┴───────────────────────────────────────────▼──────────────┐
        │ PRELOAD: typed `window.octopusAPI` (only bridge); getWindowId()    │
        └───────▲───────────────────────────────────────────▼──────────────┘
                │ IPC (typed messages)                        │
┌───────────────┴─────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Node.js)                                                        │
│   Application layer: use cases + single-writer command loop                   │
│   Domain (pure): Task, Session, WorktreeRef, State machines, Aggregator       │
│   WindowRegistry (V1.5): windowId → webContents; routes events per window     │
│   Ports → Adapters:                                                           │
│     WorktreeProvider → SelectingWorktreeProvider (Script | NativeGit)         │
│     SessionManager / SessionRuntime → PtyTerminalRuntime (node-pty)           │
│     WorkspacePersistence → SqliteStore (better-sqlite3)                        │
│     StateEvaluator (V2) → Terminal heuristic + ClaudeCode explicit            │
│     JenkinsClient (V3) → JenkinsHttpClient                                     │
│     EventBus, Clock, IdGenerator, CredentialsProvider                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Architecture style: Hexagonal (Ports & Adapters) with a thin Application layer.** The domain is pure and
depends on nothing. Every volatile edge is a port implemented by an adapter. The **composition root** (app
bootstrap) is the only place that knows concrete adapters and registers session types — this is where the
Electron/node-pty choices are localized, so they can be swapped without touching the domain.

**Dependency rule:** `UI → Application → Domain`. Adapters depend inward on ports. Nothing points into
Infrastructure except the composition root.

---

## 3. Domain Model

### 3.1 Entity–relationship overview

```
Workspace (app root)
  1 ── * Task            (ordered; ≤1 active)
  1 ── 1 WorkspaceConfig (script paths, default shell, default session type)
  1 ── 1 SessionTypeRegistry (behavior descriptors; reference, not data)

Task (aggregate root for its sessions)
  1 ── 1 WorktreeRef     (value object; required once Ready)
  1 ── * Session         (ordered tabs; ≤1 active)
  derived: TaskState     (V2+, computed from child session states)

Session (entity inside the Task aggregate)
  * ── 1 SessionType     (by typeId → resolved via registry)
  1 ── 1 SessionConfig   (type-specific value object; fully serializable)
  1 ── 0/1 RuntimeHandle  (opaque id into infra; not the process object)
  attribute: SessionState (V2+)
```

**Aggregate boundaries.** `Task` is the consistency boundary for its sessions (all add/remove/reorder/state
changes go through it, and it recomputes `TaskState`). `Workspace` is the boundary for tasks and the single
active-task pointer. **Cross-aggregate references are by id only** (never object pointers) — this keeps
persistence, event routing, and any future multi-window refactor clean.

### 3.2 Entities & value objects

- **Workspace** — `tasks: OrderedMap<TaskId,Task>`, `activeTaskId: TaskId?`, `config: WorkspaceConfig`. Owns
  the "at most one active task" rule.
- **Task** — `id`, `name` (display only), `worktree: WorktreeRef`, `sessions: OrderedList<Session>`,
  `activeSessionId?`, `lifecycle: TaskLifecycle`, `state: TaskState` (derived, V2+), timestamps.
- **Session** — `id` (globally unique), `taskId`, `typeId`, `title`, `config: SessionConfig`,
  `lifecycle: SessionLifecycle`, `state: SessionState` (V2+, default `Unknown`), `runtimeRef?`, `order`,
  `windowId: WindowId` (V1.5; which window renders it, default `MAIN_WINDOW_ID`; §3.7). `windowId` is an
  opaque assignment tag orthogonal to `taskId` — moving a session between windows never changes `taskId`
  (I7) or lifecycle (I9), so it is **not** a cross-aggregate object reference, just a presentation label.
- **WorktreeRef** (immutable once set) — `path: AbsolutePath`, `branch?` (the new branch), `baseRef?`
  (the source branch it was cut from), `provisionedBy: ScriptInvocationMeta` (whose `repoRoot` is the
  per-task repo directory). `branch`/`baseRef` are populated from the create modal (§5.4); a repo-local
  create script that ignores them may still leave them set to the requested values. Provisioning *status*
  lives in `TaskLifecycle`, not here.
- **SessionType** (registry descriptor, behavior not data) — `typeId`, `displayName`, `icon`,
  `availableFromVersion`, `configSchema`, `capabilities: Set<Capability>`, runtime factory reference.
- **SessionConfig** — per-type, validated against the type's `configSchema`. Must be fully serializable so a
  session can be recreated on restart. Terminal: `{ shell?, initialCommand?, cwdOverride? }` (defaults to the
  worktree path). Jenkins (V3): `{ jobPath, branch (defaults to worktree branch), credentialsRef }`.

### 3.3 State enums

```
enum SessionState { Unknown, Waiting, Working, Blocked }   // + internal sub-states, §9.1
enum TaskState    { Unknown, Waiting, Working, Blocked }   // derived only
```

Internal-only session sub-states (feed confidence scoring, not the UI): `Waiting/AtPrompt`,
`Waiting/Explicit`, `Working/Subprocess`, `Working/Explicit`, `Blocked/Permission`, `Blocked/Explicit`,
`Blocked/Heuristic`, `Initializing` (mapped to `Working` for display). See §9.

### 3.4 Task-state aggregation (V2+)

**Rule — worst-status-wins**, a pure `max` over the lattice `Blocked > Working > Waiting > Unknown`:

```
aggregate(sessions):
    known = [s for s in sessions if s.state != Unknown]
    if known is empty: return Unknown          # empty task or all-unknown → Unknown (no icon)
    if any s.state == Blocked: return Blocked
    if any s.state == Working: return Working
    return Waiting
```

**Justification.** The icon exists to direct attention across many parallel tasks. `Blocked` demands action
(highest); `Working` means "in flight, no action" (middle); `Waiting` means idle-needs-command (low);
`Unknown` is transparent so an un-evaluated terminal never masks a blocked build. The reduction is total,
associative, and commutative → order-independent, incrementally recomputable, trivially testable.

**Pluggability.** Implement as a `TaskStateAggregator` strategy so the alternative "Waiting > Working"
precedence can be offered as a setting without touching the `Task` entity. Empty task → no icon (never
`Waiting`, which would imply the user has something to act on).

### 3.5 Task lifecycle

```
 createTask(name,repoDir,sourceBranch,newBranch)
 [None] ──▶ (Provisioning) ──run WorktreeProvider.create──┐
                    success ▼                    failure ▼
                        (Ready) ◀──┐          (ProvisionFailed) ──retry/discard──▶ [None]
        deleteTask()   │           │  (no worktree attached; nothing to tear down)
                       ▼
                  (Deleting)   1) stop+dispose ALL sessions  2) WorktreeProvider.remove  3) remove task
              success ▼        failure ▼
              (Deleted)       (DeleteFailed) ──retry / force-forget──▶ (Deleted)
```

A task appears as a normal task only in `Ready`/`Deleting`. `Provisioning` shows a spinner;
`ProvisionFailed` is an error affordance, guaranteeing no half-created task with an invalid worktree enters
the list. `DeleteFailed` retains metadata so the user can retry or "force-forget".

### 3.6 Session lifecycle

```
 openSession(type,cfg)
 [None] ──▶ (Created) ──validate cfg──▶ (Starting) ──runtime.start()──┐
                 invalid ▼                              success ▼   failure ▼
             (CreateFailed)                              (Running)   (StartFailed)
                                                   close / exit ▼
                                                    (Stopping) ──dispose──▶ (Closed)
```

`SessionLifecycle` ("is the runtime alive?") is **orthogonal** to `SessionState` ("what is it doing?", V2+).
Switching tasks never changes lifecycle — background sessions stay `Running`; visibility is a UI concern, not
a domain state. A `StartFailed`/`Exited` session maps to `Blocked` for aggregation.

### 3.7 Window model (V1.5)

Octopus runs across **multiple OS windows** (one per monitor). This is deliberately a **presentation +
persistence concept, not a domain aggregate** — the domain stays pure and its invariants unchanged:

- **`WindowId`** — a branded string id (like `TaskId`/`SessionId` in `src/domain/ids.ts`). A named constant
  **`MAIN_WINDOW_ID`** identifies the single main window (stable, persisted — not a magic `null`).
- **`Session.windowId: WindowId`** (§3.2) — the only domain touchpoint: an opaque tag saying *which window
  renders this session right now*. It drives no rule and no lifecycle, exactly as `WorktreeRef.path` is a
  "where it runs" bag on `Task`. The one mutation is `Session.assignToWindow(windowId)`; `taskId` is never
  touched (I7 holds). Defaults to `MAIN_WINDOW_ID` at creation.
- **`WindowRecord`** `{ id, role: 'main' | 'secondary', bounds: {x,y,width,height}, createdAt }` — lives
  **only** in the `WorkspacePersistence` port + `SqliteStore` + `main` process. **Pixel geometry never enters
  the pure domain.** Bounds are saved (debounced) on move/resize and restored at boot (§6.3, §6.7).

**Sync model.** All windows share the single existing `activeTaskId` pointer (§3.2). A given window `W`
renders exactly the sessions where `session.taskId === activeTaskId && session.windowId === W`. Switching the
active task therefore switches sessions in **every** window simultaneously — the `activeTaskChanged` event is
just broadcast to all windows (§6.7). A window may render **zero** sessions (empty state). `activeSessionId`
within a task is a per-window UI selection, not shared. Roles: the **main** window shows the progress panel
and sessions; **secondary** windows are session-only.

---

## 4. Technology Stack

| Concern | Choice | Rationale | Fallback |
|---|---|---|---|
| Desktop shell | **Electron** | `xterm.js` + `node-pty` is battle-tested (VS Code, Hyper, Tabby); Chromium renders xterm.js at full fidelity incl. WebGL; all deps vendorable for air-gapped install. | Native Qt + QTermWidget |
| UI framework | **React 18 + TypeScript** | Component tree maps cleanly onto task/session hierarchy. | — |
| Build | **electron-vite (Vite)** + electron-builder | Fast HMR for main/preload/renderer; offline production builds. | — |
| State mgmt | **Zustand** | Low boilerplate; high-frequency PTY data is **not** routed through the store (avoids render churn). | Redux Toolkit |
| Terminal | **xterm.js** + addons: `fit`, `webgl` (canvas fallback), `search`, `web-links`, `unicode11`, `serialize` | Performance for high-throughput output; Unicode for Claude Code glyphs. | — |
| PTY | **node-pty** in main process | De-facto standard; internal SIGCHLD reaping. | portable-pty (if ever Tauri/Rust) |
| Persistence | **SQLite (better-sqlite3)** | ACID partial updates; single file; sub-ms at this scale. | JSON (settings only) |

**Why Electron over Tauri here:** Tauri's Linux WebView is WebKitGTK, where xterm.js WebGL support is less
reliable and the Rust PTY story is thinner. For a terminal-centric IDE, xterm.js fidelity and node-pty
reliability are load-bearing; Electron's larger bundle is irrelevant for a developer tool. Air-gapped is not a
complication — npm deps are vendored, Electron is bundled, no runtime network access needed.

---

## 5. Frontend Architecture

### 5.1 Component tree

```
App
├── ProgressPanel
│   ├── PanelHeader → NewTaskButton, DeleteTaskButton
│   └── TaskList → TaskListItem*  (TaskStatusIcon [V2] + label)
└── TaskWorkspace
    └── TaskView*                 (one per task; only active is visible)
        ├── SessionTabBar → NewSessionDropdown, SessionTab* (SessionStatusIcon [V2])
        └── SessionPaneArea → SessionPane*  (TerminalPane | JenkinsPane [V3])
```

All `TaskView`s and their `SessionPane`s stay mounted; only the active ones are visible (see §5.3).

### 5.2 State management & data flow

Zustand store holds: `tasks`, `sessions`, `activeTaskId`, `activeSessionId` (per task), and (V2)
`sessionStatuses` + derived `taskStatuses` (selector applying §3.4). **High-frequency `ptyData` bypasses the
store** — it is delivered by IPC directly to the target `TerminalPane`'s `terminal.write(data)`. On startup
the renderer calls `app:getState` (§6.5) to hydrate; thereafter lifecycle/status events patch the store.

```
Keystroke:  xterm onData → octopusAPI.pty.input → ipcMain → pty.write
Output:     pty onData → (batched, §6.5) → webContents.send('pty:data') → terminal.write   [not via store]
New task:   modal → octopusAPI.tasks.create → provision worktree (script or native git) → persist → resolve → store.createTask
Status(V2): evaluator → send('session:status') → store.updateSessionStatus → icons re-render
```

### 5.3 Keep-alive on task switch (critical)

**Chosen approach: mount all sessions, toggle visibility via CSS.** Each `xterm.Terminal` is created once
(in a `useRef`, `useEffect([])`) and never destroyed until the session closes. Hidden sessions use
`visibility:hidden; position:absolute; width/height:0` — **not `display:none`** (which drops the WebGL
context). `terminal.write(data)` keeps running for hidden sessions so their buffer stays current.

- **On show:** `fitAddon.fit()` → `pty:resize` → `terminal.refresh(0, rows-1)`.
- **On hide:** nothing; PTY and buffer remain live.
- **Scale mitigation:** browsers cap simultaneous WebGL contexts (~16). Above ~15 concurrent sessions, demote
  hidden terminals from the WebGL renderer to the Canvas renderer (still hardware-accelerated, fine for
  background buffering). Bound `scrollback` to ~10 000 lines/terminal.
- **Software-GL displays (VDI/no-GPU):** the tier is also gated on GPU capability (`gpu-capability.ts`
  probes `WEBGL_debug_renderer_info` once at startup). On a software rasterizer — SwiftShader, llvmpipe,
  e.g. a VMware Horizon virtual desktop with no GPU — WebGL/Canvas do **not** throw; they "succeed" on the
  CPU and then stall every frame on a synchronous `ReadPixels` readback (observed as multi-second lag typing
  in a full-frame TUI like emacs/Spacemacs, plus `GPU stall due to ReadPixels` in the GPU log). There we skip
  **both** accelerated tiers and leave xterm on its built-in **DOM renderer** (spans + CSS, no canvas, no
  readback), which the X server / remoting layer blits cheaply — the fastest path when there is no real GPU.
  This auto-reverts to WebGL on a real-GPU host.

Rejected: unmount + backend-buffered replay (perceptible 50–300 ms "pop" on switch, cursor/selection
restore complexity). The serialize-and-replay path is kept available for a future durable-backend re-attach
(§6.2), not for routine task switching.

### 5.4 UX details

- **Tabs:** horizontal scroll on overflow with chevrons; overflow "…" menu beyond ~8 tabs; drag-reorder via
  `@dnd-kit/core`; per-tab `×` close (fires `pty:destroy`).
- **New Task:** modal with four fields — **name**, **repo directory** (a native OS directory picker via a
  `dialog:pickDirectory` IPC), **source branch**, **new branch** (prefilled with a slug from the name,
  editable). "Create Task" → spinner while the worktree is provisioned (repo-local script or native git,
  §6.4) → on success new task becomes active with empty state; on failure show stderr in a red block +
  Retry + toast.
- **New Session:** dropdown populated from the session-type registry (filtered by `availableFromVersion ≤
  currentVersion`). Terminal creates immediately; Jenkins (V3) opens a small config modal.
- **Delete Task:** confirm dialog ("closes all sessions and removes the worktree"); on dirty worktree, an
  extra "uncommitted changes — delete anyway?" confirmation.
- **Status icons (V2):** shape **and** color (accessibility): Waiting = hollow/pause, gray; Working =
  spinner/filled, blue; Blocked = warning triangle, amber. Low-confidence heuristic states render dimmed or
  pulsing. Tooltips give plain-text descriptions.
- **Keyboard:** `Ctrl+Shift+]`/`[` cycle tasks; `Ctrl+Tab`/`Ctrl+Shift+Tab` cycle sessions; `Ctrl+Shift+T`
  new terminal; `Ctrl+Shift+N` new task; `Ctrl+Shift+W` close session; `Ctrl+Shift+F` terminal search;
  `Ctrl+Shift+C/V` copy/paste; `Esc` close modal/dropdown. Only `Shift`-modified shortcuts are intercepted
  globally so terminal `Ctrl+C` etc. are never stolen.
- **Empty states & toasts:** "No tasks yet", "No sessions", inline "Connecting…" written into the terminal;
  bottom-right toasts for script failures, unexpected PTY exit, Jenkins errors (V3).

### 5.5 Renderer / main split

- **Main:** all node-pty instances, worktree script execution, IPC server, filesystem, persistence, state
  evaluators (V2), Jenkins HTTP client (V3). Source of truth for persisted state — survives renderer reload.
- **Preload:** exposes only a typed `window.octopusAPI` via `contextBridge`; renderer never touches
  `ipcRenderer`/Node directly.
- **Renderer:** rendering, Zustand store, xterm instances (in refs, never serialized to store), IPC
  subscription setup.

### 5.6 Multiple windows (V1.5)

Each OS window is a **separate Electron renderer process** with its own Zustand store. Two roles:

- **Main window** — the existing layout (`ProgressPanel` + `TaskWorkspace` + `Toaster` + modals), plus a
  **New Window** button in the panel header.
- **Secondary window** — session-only: no `ProgressPanel`; a `SecondaryWorkspace` renders the sessions of
  the active task assigned to *this* window. `App.tsx` branches on `windowRole` to pick the layout.

**Identity.** A renderer learns its own id synchronously via `octopusAPI.app.getWindowId()`, which reads a
`?windowId=<id>` query param injected into the renderer URL at window creation (§6.7) — no IPC round-trip.
`windowRole`/`windowId`/`windows` are added to the store, hydrated from the (extended) `getState` DTO.

**Rendering & keep-alive.** The §5.3 rules are unchanged and apply **per window**: every session assigned
to a window stays mounted with `visibility:hidden` when not the active tab (never `display:none`).
`SecondaryWorkspace` filters the session set to `session.windowId === thisWindowId`. The WebGL context
budget (`terminal/webgl-budget.ts`, §5.3) is a **module-level** singleton and thus already **per-renderer-
process** — each window gets its own ~15-context budget with no change, and on a software-GL/VDI host every
window independently stays on xterm's DOM renderer.

**Cross-window drag & drop — *detach + drop-on-window*.** `@dnd-kit` is DOM-scoped and cannot cross a
`BrowserWindow` boundary, so a single HTML5 drag can't travel between windows like intra-bar tab reorder
(§5.4) does. The gesture: dragging a tab **out of** its `SessionTabBar` (pointer leaves the bar by ~20 px)
switches to *detach mode* — the in-window dnd-kit drag is cancelled, and on `pointerup` the renderer reads
the native `screenX/screenY` and calls `octopusAPI.windows.windowAtPoint({x,y})` (§6.7). If the drop lands
over another Octopus window → `sessions.move({sessionId, targetWindowId})`; if it lands on empty desktop →
`createWindowWithSession` opens a new secondary window at the drop point and moves the session into it. The
move is a pure view re-assignment — the PTY keeps running untouched (§6.7).

---

## 6. Backend: Process, PTY, Persistence, IPC

### 6.1 PTY management

Each terminal session spawns one PTY via node-pty:

```
node-pty.spawn(shell, ["-l"], {
  name: "xterm-256color", cols, rows, cwd: worktreePath,
  env: { ...inherited, TERM:"xterm-256color", COLORTERM:"truecolor",
         OCTOPUS_TASK_ID, OCTOPUS_SESSION_ID, OCTOPUS_WORKTREE,
         OCTOPUS_STATE_SOCKET /* V2, §9 */,
         /* stripped: TMUX, STY, WINDOWID */ } })
```

- **Shell:** setting `terminal.shell`, else `$SHELL`, else `/bin/bash`; login shell (`-l`) so profiles load.
- **cwd:** the task's worktree path (from the task record at session creation).
- **Resize:** `ResizeObserver` (debounced ~50 ms) → `fit()` → `pty:resize` → `pty.resize` → kernel
  `TIOCSWINSZ` delivers SIGWINCH automatically.
- **Exit:** node-pty `onExit` reaps the child (waitpid) → mark `Exited`, emit `sessionExited`, retain
  scrollback so the user can read final output.
- **Close:** SIGHUP; if still alive after 2 s, SIGKILL. (V2+: spawn each shell via `setsid` so SIGKILL to the
  group also kills descendants — compilers, agents.)
- **FD limits:** raise `RLIMIT_NOFILE` to 65536 at startup (default 1024 is exhausted by dozens of PTYs).

### 6.2 In-process vs daemon vs tmux

**V1: in-process** (PTYs owned by the Electron main process). Simplest, no extra infrastructure, and the core
V1 value is task/session organization — not crash resilience. **Trade-off accepted:** an app/main-process
crash orphans running processes; on restart Octopus recreates *fresh* shells at the correct worktree cwd
(metadata persists; live process state does not).

**Migration path (V2+): durable session backend without a renderer rewrite.** Define a **`SessionManager`
port**; V1 uses `ElectronSessionManager` (in-process node-pty over Electron IPC). A later
`DaemonSessionManager` runs PTYs in a long-lived `octopusd` (or attaches to **tmux** windows) over a Unix
socket, with a server-side ring buffer (~5 MB/session) replayed on re-attach. The **renderer talks only to
the `SessionManager` interface and never changes.** tmux is the recommended durable backend if/when
process-survival-across-restart becomes a requirement, since it gives persistence and multi-attach for free.

### 6.3 Persistence

**SQLite** at `$XDG_DATA_HOME/octopus/octopus.db` (Linux) / `%APPDATA%\octopus\octopus.db` (Windows). Global
settings in a sibling `settings.json` (small, human-editable). Schema (simplified):

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, worktree TEXT NOT NULL, branch TEXT,
  base_ref TEXT, repo_root TEXT, created_at INTEGER NOT NULL, position INTEGER NOT NULL,
  active_session_id TEXT);  -- branch=new branch, base_ref=source branch, repo_root=per-task repo dir; all nullable (§6.4)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL, label TEXT NOT NULL, shell TEXT, position INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown', created_at INTEGER NOT NULL, exited_at INTEGER,
  window_id TEXT NOT NULL DEFAULT 'main');  -- V1.5: which window renders it (§3.7); default = main
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- e.g. active_task_id
CREATE TABLE windows (  -- V1.5: window records incl. monitor placement (§3.7, §6.7)
  id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('main','secondary')),
  x INTEGER NOT NULL DEFAULT 0, y INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 1280, height INTEGER NOT NULL DEFAULT 800,
  created_at INTEGER NOT NULL);
```

**Persist:** task list/name/worktree/branch/base_ref/repo_root/order/active-session; session definitions
(id, type, label, shell, order); active task; global settings. **Cannot persist:** live PTY/TTY state and the
foreground process. **Restore:** verify each worktree path exists (else mark task `Stale` with a warning,
don't start sessions); for each terminal session, open a fresh PTY in the worktree (V1) or re-attach (durable
backend). Persisted scrollback is metadata, independent of the live PTY (I13): it is loaded and published
(as a `ptyData` event) **ahead of** the fresh PTY spawn, so restored history paints immediately without
waiting on the shell fork. The `repo_root` column round-trips the per-task repo directory so
delete-after-restart re-invokes the correct repo-local script / git repo (§6.4).

**Schema version:** `PRAGMA user_version` is stamped with the current version. Adding `base_ref` bumped it
to **2**; `SqliteStore` runs a guarded, idempotent `ALTER TABLE tasks ADD COLUMN base_ref TEXT` when it
opens a `user_version < 2` database (§10 — this is the first use of the migration seam). Persisted scrollback
bumped it to **3**. **V1.5 (multi-window) bumps it to 4:** a guarded `ALTER TABLE sessions ADD COLUMN
window_id TEXT NOT NULL DEFAULT 'main'` (the default migrates every existing session to the main window with
no UPDATE pass), a `CREATE TABLE IF NOT EXISTS windows`, and an `INSERT OR IGNORE` seeding the `main` window
record — the same fresh-DB-`CREATE`-plus-guarded-upgrade pattern proven at v2/v3.

**Windows persistence (V1.5, §3.7, §6.7).** `WorkspacePersistence` gains `loadWindows/upsertWindow/
deleteWindow`. Window **bounds** are saved (debounced) on OS move/resize; the session's `window_id` is
saved via the normal `upsertSession`. **Restore:** at boot, main creates a `BrowserWindow` for every
persisted `WindowRecord` at its saved bounds, but **clamps off-screen bounds** — if a saved window
intersects no current display work area (`screen.getAllDisplays()`, e.g. a monitor was unplugged) its
top-left is snapped into the nearest display, preserving width/height. Each restored session then renders in
whichever window its `window_id` names (falling back to the main window if that window record is gone).

### 6.4 Worktree provisioning contract

Worktree create/delete go through the `WorktreeProvider` port. The V1 implementation is a
`SelectingWorktreeProvider` composing two adapters behind that single unchanged port (§10): a
**`ScriptWorktreeProvider`** (repo-local user script) and a **`NativeGitWorktreeProvider`** (Octopus runs
git itself). The selector **probes per task** — `<repoDir>/create_worktree.sh` (resp. `delete_worktree.sh`)
in the task's chosen repo directory — and delegates to the script provider if the file exists, else to the
native provider. `repoDir` comes from the New-Task modal (§5.4) and is stored per task (`repo_root`), so
different tasks may target different repos, some with custom scripts and some without. Both paths run
through the same `ScriptRunner` (argv, `shell:false`, timeouts, captured stdout/stderr — I17); native git is
never handed a shell string.

**Create.** Both paths receive the source branch and the new branch; env `OCTOPUS_REPO_ROOT` (= `repoDir`),
`OCTOPUS_TASK_ID`, `OCTOPUS_VERSION`; cwd `repoDir`; **timeout** 30 s (configurable via
`worktreeCreateTimeoutMs`) → SIGTERM, 2 s, SIGKILL. On failure (non-zero exit / timeout / validation) the
task is **not** created; stderr is surfaced.
- **Repo-local script** — invoked `create_worktree.sh <source-branch> <new-branch>`. **stdout:** first
  non-empty line = absolute worktree path; the script owns *where* the worktree lives. Octopus validates the
  path minimally (absolute, exists, is a directory), warns (does not reject) if it doesn't look like a git
  worktree, and stores it verbatim as the session cwd.
- **Native git** — Octopus computes the path under the configured base dir `worktree.location` (default
  `~/octopus_repos/`, created if missing) as `<location>/<sanitized-new-branch>-<short-task-id>` (flat
  layout; the id suffix guarantees uniqueness), then runs
  `git -C <repoDir> worktree add -b <new-branch> <computed-path> <source-branch>`. The computed path is
  validated the same way and stored.

```bash
#!/usr/bin/env bash
# <repo>/create_worktree.sh — optional; only needed when native `git worktree` isn't enough.
set -euo pipefail
SOURCE_BRANCH="$1"; NEW_BRANCH="$2"
WORKTREE_PATH="${OCTOPUS_REPO_ROOT}/../worktrees/${NEW_BRANCH//\//-}-${OCTOPUS_TASK_ID:0:8}"
cd "$OCTOPUS_REPO_ROOT"
git worktree add -b "$NEW_BRANCH" "$WORKTREE_PATH" "$SOURCE_BRANCH" 1>&2   # diagnostics → stderr
echo "$WORKTREE_PATH"                                                      # only the path → stdout
```

**Delete** — symmetric. If `<repoDir>/delete_worktree.sh` exists it is invoked
`delete_worktree.sh <task-name> <worktree-path>` (stdout ignored; exit 0 = success, non-zero → warn but the
task record is still removed since the user asked); otherwise Octopus runs
`git -C <repoDir> worktree remove <worktree-path>` (with `--force` when the user has confirmed deletion of a
dirty worktree — see the gate below — since git refuses a dirty tree otherwise). **Safety checks before
calling either path:** (1) path sanity — the path is exactly the one stored for this task, is absolute, and
is neither `/` nor `repoDir` nor an ancestor of it; (2) uncommitted changes — `git -C <wt> status
--porcelain` non-empty → confirm dialog; (3) all sessions killed first (SIGHUP, 2 s, SIGKILL) so nothing
holds an fd inside the worktree. Stderr (≤64 KB) is shown in an error dialog with the command + exit code.

### 6.5 IPC protocol

**V1 transport:** Electron `contextBridge` + `ipcMain`/`ipcRenderer`, all behind the typed `octopusAPI`.
Request/reply commands use `ipcMain.handle` (with a renderer-generated `requestId`); streaming `ptyData` uses
`webContents.send` to avoid head-of-line blocking. The message set is transport-agnostic so the V2 daemon can
carry it over a Unix socket unchanged.

```
Commands (UI→backend): createTask{name,repoDir,sourceBranch,newBranch}, deleteTask{force?},
  renameTask, reorderTask, createSession, closeSession, renameSession, reorderSession,
  writeToPty, resizePty, getState, updateSettings
Queries (UI→backend, no domain mutation): pickDirectory (native OS folder picker for the New-Task modal)
Events (backend→UI):  ptyData, sessionCreated, sessionExited, sessionClosed,
  taskCreated, taskDeleted, taskRenamed, taskStale, scriptProgress, scriptError,
  sessionStateChanged (V2), taskStateChanged (V2), error
```

### 6.6 Concurrency & resilience

- **Output batching / back-pressure:** per-session accumulator, **leading-edge**: the first chunk arriving
  on an idle buffer flushes immediately (so an interactive keystroke echo — e.g. typing in `vi` — meets the
  §11 `<5 ms` target instead of waiting a whole interval), then a **short 3 ms** trailing timer coalesces any
  follow-up chunks in the window into one flush; a 256 KB cap forces an immediate flush regardless. The window
  is short by design: a `vi` redraw arrives as several back-to-back chunks (cursor hide → glyph → cursor show),
  so leading-edge alone would flush the invisible cursor-hide instantly but leave the visible glyph waiting out
  the window — felt as input lag. xterm already paces painting to ~60 Hz via `requestAnimationFrame`, so this
  timer does not gate the render rate; it only bounds IPC message *count*, and under a genuine flood the 256 KB
  byte-cap dominates (flushes become byte-driven, not timer-driven) — so 3 ms carries no IPC-storm risk.
  node-pty has no flow control by design (blocking a PTY would stall an interactive agent) — manage on the
  output side. **Inactive tabs:** don't send `ptyData`; append to the per-session ring buffer (~500 KB) and
  replay on tab activation.
- **Single-writer domain:** all domain mutations (including ingested `sessionStateChanged`) are commands on
  one logical writer; adapters do I/O off-thread and feed results back as events. No locks around aggregates;
  deterministic tests. better-sqlite3 is synchronous but sub-ms; move to a worker thread only if profiling
  demands.
- **Task-delete ordering (strict):** set `deleting` flag → dirty check (confirm) → kill all PTYs → run delete
  script → remove rows in one transaction → emit `taskDeleted`. Delete-script failure still removes the task
  (+ warning).
- **App quit:** SIGHUP all PTYs (fire-and-forget), `PRAGMA wal_checkpoint(TRUNCATE)`, then quit. Warn the
  user if any session is `Working`/`Blocked`.

### 6.7 Multi-window backend (V1.5)

**Event routing — `WindowRegistry`.** The single-target event forwarder (§6.5, one `webContents`) is
replaced by a **`WindowRegistry`**: a `Map<WindowId, { webContents, ready, pending[] }>` with **one** bus
subscription whose closure routes each mapped `EventDTO` by kind:
- **`ptyData` and session-scoped events** (`sessionCreated/Exited/Closed/Renamed/Reordered`) → **only the
  window hosting that session** (look up `session.windowId`; drop silently if the session is mid-close).
- **`sessionMovedToWindow`** (new) → **both** the source and target windows, so both re-render in one cycle.
- **Task-level / broadcast events** (`taskCreated/Deleted/Renamed/Reordered/Stale`, `activeTaskChanged`,
  `scriptProgress/Error`, `error`, settings, and the dormant V2 `sessionStateChanged/taskStateChanged`) →
  **all** windows — every window keeps its active-task view (and the main window its full task list) correct.

Each window identifies itself at creation via a `?windowId=<id>` URL param (§5.6). Per-window `markReady`
fires from that window's `getState` call — the handler resolves the caller via
`BrowserWindow.fromWebContents(e.sender)` — so each renderer's buffered startup events flush exactly when it
can receive them (generalizes the §6.5 single-window `onHydrate`).

**New protocol (transport-agnostic, §6.5 — the V2 daemon carries `windowId` unchanged):**
- **Commands:** `createWindow{role:'secondary', bounds?}`, `closeWindow{windowId, disposition:'move-to-main'
  | 'kill-sessions'}`, `moveSessionToWindow{sessionId, targetWindowId}`, and `createWindowWithSession
  {sessionId, bounds?}` (atomic create-then-move so the drop-on-desktop path is one dispatch, not a racy
  two-round-trip).
- **Query (bypasses the command loop, like `pickDirectory`):** `windowAtPoint{x,y}` → the `windowId` of the
  Octopus window whose OS bounds contain the screen point, or `null` (empty desktop). Used by cross-window DnD.
- **Events:** `windowCreated`, `windowClosed`, `sessionMovedToWindow{sessionId, taskId, fromWindowId,
  toWindowId}`.

**Move choreography (reuses the existing replay path — no PTY restart).** PTYs are keyed only by `sessionId`
in main, so moving a session is a pure view re-assignment: `moveSessionToWindow` →
`session.assignToWindow(target)` → `upsertSession` → emit `sessionMovedToWindow`. The **source** renderer
unmounts the `SessionPane`/xterm (its cleanup unregisters the sink, releases the WebGL lease); the **target**
renderer mounts a fresh xterm and its `registerTerminalSink` replays the `pty-router` pending ring buffer
(the same 500 KB pre-mount buffer used at session restore, §6.6). The session is `Running`, not `Created`, so
`startTaskSessions` is **not** re-triggered — no scrollback reload from SQLite, no flash. Subsequent `ptyData`
is routed by the registry to the new window.

**Window lifecycle.** *New Window* → `createWindow` (secondary). *Closing a secondary window* with live
sessions shows a modal dialog (move-to-main vs kill-sessions vs cancel) → `closeWindow{disposition}`
(move-to-main bulk-moves its sessions to the main window; kill-sessions closes each). *Closing the main
window* quits the app: it triggers the §6.6 graceful shutdown (persist everything, SIGHUP PTYs, checkpoint).
A quit-in-progress (`before-quit`) sets an `isQuitting` flag that suppresses the secondary close dialog so a
`Ctrl+Q` isn't blocked. `window-all-closed` no longer force-quits (secondary closes must not kill the app).

---

## 7. Invariants & Consistency Rules

- **I1.** A task in `Ready`/`Deleting` must have a valid `WorktreeRef`; a task only reaches `Ready` after the
  create script succeeds and validation passes.
- **I2.** `WorktreeRef` is immutable after provisioning (re-pointing would break running sessions' cwd).
- **I3.** `deleteTask` must (1) stop/dispose all sessions, (2) run the delete script, (3) remove the task —
  in that order; enforced in the `Deleting` state, not the UI.
- **I4.** Deletion is resilient/idempotent: worktree already gone or script error → `DeleteFailed` with a
  "force-forget" escape hatch.
- **I5.** `SessionId` is globally unique (so `sessionStateChanged(sessionId,…)` routing needs no task
  context). **I6.** `TaskId` unique in the workspace. **I7.** A session belongs to exactly one task and
  cannot move between tasks (each task is a distinct worktree). **I8.** Task names need not be unique (soft UX
  warning only; identity is `TaskId`).
- **I9.** ≤1 `activeTaskId`; switching tasks changes only visibility, never any session's lifecycle.
  **I10.** `activeSessionId` (if set) references a session in that task.
- **I11.** `TaskState` is always derived, never assigned; recomputed on session add/remove and on each
  ingested `sessionStateChanged` (pure `max` → cannot drift).
- **I12.** An `Exited`/`StartFailed` session maps to `Blocked` for aggregation; a session without the
  `EvaluatesState` capability is `Unknown` and transparent unless it is the only signal.
- **I13.** On quit: persist metadata + gracefully terminate processes; do **not** resurrect live process
  state. **I14.** Worktrees persist on disk; on startup reconcile each task's worktree path (missing →
  `Stale`/degraded with re-provision or force-forget). **I15.** On restart, sessions are recreated from
  serialized `SessionConfig` (fresh terminal / fresh Jenkins viewer).
- **I16.** Never persist secrets. Jenkins config stores a `credentialsRef`; a `CredentialsProvider` port
  resolves it from the OS keychain (libsecret) at runtime. Define this port's shape in V1's persistence
  design so V3 doesn't retrofit secret handling.
- **I17.** User scripts, native `git` invocations, and terminal commands are a trust boundary: run via
  `ScriptRunner` with explicit cwd, **no shell-string interpolation of untrusted names** (branch names,
  paths, and repo dirs are passed as argv elements with `shell:false`), timeouts, captured exit/stderr.
- **I18.** (V1.5) A session has exactly one `windowId` at all times (default `MAIN_WINDOW_ID`); moving it
  between windows changes only `windowId`, never `taskId` (I7) or lifecycle (I9). A session whose persisted
  `window_id` names a window that no longer exists falls back to `MAIN_WINDOW_ID` on restore (never orphaned).
  On restore, windows and their session assignments are reconstructed alongside tasks/sessions (extends
  I13/I14/I15) — live process state is still not resurrected (fresh PTYs, I13).

---

## 8. Extensibility: Session Types

Separate **behavior** (domain-facing, UI-agnostic) from **rendering** (UI-specific) via a **two-part
registry**:

1. **`SessionTypeProvider`** (Application/domain edge): `typeId`, `displayName`, `icon`,
   `availableFromVersion`, declarative `configSchema` (drives the New-Session dialog + validation),
   `capabilities` (e.g. `EvaluatesState`), and `createRuntime(session, context) → SessionRuntime`. The
   **New-Session dropdown is populated purely from this registry.**
2. **`SessionViewFactory`** (UI layer, keyed by the same `typeId`): `mount(runtimeHandle, container)` /
   `unmount()`. Renders the terminal emulator or Jenkins view.

**`SessionRuntime`** exposes `start()/stop()/dispose()`, a type-neutral output/interaction handle, and an
optional `stateEvaluator()` (present iff `EvaluatesState`). State is **push-based**: the runtime emits
`sessionStateChanged` on the `EventBus`; the Application ingests it and recomputes `TaskState`.

**Acceptance test for the abstraction:** adding Jenkins (V3) is a `JenkinsSessionTypeProvider` +
`JenkinsViewFactory` + a `JenkinsHttpClient` adapter, registered at the composition root — **zero edits** to
`Task`, the aggregator, or the dropdown logic. If adding a type required editing those, the abstraction is
wrong. V1 uses static registration (Terminal only); dynamic/third-party plugin loading is deferred but
additive behind this registry.

---

## 9. Session-State-Detection Subsystem (V2 core)

This is the hardest part of V2. Terminal state is inferred from **layered signals, highest-confidence wins**.

### 9.1 Signal layers

```
Layer 3 (AUTHORITATIVE): explicit application signals
   • Claude Code hooks → per-session Unix socket   (§9.2)
   • OSC 9000 in-band state escape sequence
   → accurate Waiting / Working / Blocked
Layer 2 (HIGH): OS-structural signals
   • OSC 133 semantic prompt marks (A/B prompt, C command-start, D;exit command-end)
   • tcgetpgrp(master_fd) vs shell PGID  (shell foreground = at prompt; child = running)
   → reliable Waiting / Working; cannot see Blocked
Layer 1 (LOW): PTY output-activity timing
   → tie-breaker / sanity check only (false positives on silent compiles & blocked prompts)
```

**Decision logic:** use Layer 3 if a signal arrived within `T_explicit` (30 s, refreshed per signal); else
Layer 2; else Layer 1. `Blocked/Heuristic` is emitted only when Layer 2 says Working, the foreground process
is identified as Claude Code (`/proc/<pgid>/comm`), and the PTY has been silent >8 s — meaningful
false-positive rate, so render it dimmed/pulsing. **Conflict:** Layer 3 wins on freshness, but a fresh Layer 2
structural signal (shell returned to foreground, i.e. an OSC 133 `D`) overrides a **stale** Layer 3 Working
(handles Claude Code exiting without a Stop hook). Degrade Layer 3 → Layer 2 after `T_stale` = 60 s.

**Baseline for any terminal:** Octopus injects OSC 133 shell integration into its own terminals (via an
`--rcfile`/profile snippet) so Waiting/Working are reliable even without app-specific hooks.

### 9.2 Claude Code explicit signal (the only reliable `Blocked`)

"Blocked waiting for permission" is internal to Claude Code — no OS primitive exposes it (it is foreground,
has printed a prompt, and is reading stdin — indistinguishable from Waiting from outside). Solution:

- Octopus creates a per-session socket `/tmp/octopus-<uid>/session-<uuid>.sock` (dir `chmod 700`), exports
  `OCTOPUS_STATE_SOCKET`, and listens async on it.
- Octopus writes `.claude/settings.json` into the worktree wiring hooks to tiny one-liners:
  - `Stop` → `{"state":"waiting","reason":"claude_stop"}`
  - `PreToolUse` (permission) → `{"state":"blocked","reason":"permission_request","tool":"…"}`
  - `PostToolUse` → `{"state":"working","reason":"tool_use","tool":"…"}`
- The `ClaudeCodeProvider` treats socket messages as authoritative. **Graceful degradation:** socket
  unset/gone → `nc` fails silently → fall back to heuristic. Messages are validated (≤1 KB, valid JSON, known
  state values); nothing from a message is ever executed.

Alternatives (inferior): parsing Claude Code's terminal output (brittle, version-coupled) or an Octopus MCP
server (richer but heavier — defer).

### 9.3 State model, providers, debouncing

- **`StateProvider` interface:** `initialize(ctx)`, `poll()`, `get_state() → StateSnapshot{state,
  confidence, assessed_at, reason, layer}`, `teardown()`. Confidence ∈ {Authoritative, High, Medium, Low,
  None}; Medium/Low set a `low_confidence` flag the UI dims.
- **Composition:** a Claude-Code terminal uses a `CompositeStateProvider` = `TerminalHeuristicProvider`
  (Layers 1+2) + `ClaudeCodeProvider` (Layer 3), applying §9.1 logic. Jenkins (V3) uses `JenkinsProvider`.
- **Delivery:** OSC parsing and socket reads are event-driven (in the PTY read loop / async socket);
  `tcgetpgrp` polled at 200 ms; PTY-activity checked at 1 s.
- **Debounce/hysteresis (anti-flicker):** min 500 ms hold; `Working→Waiting` requires 1 s stability;
  `Waiting→Working` immediate; **`Blocked` immediate, no debounce**; `Unknown` emitted once at start.
  Task-level aggregation also debounced 300 ms (except Blocked).

### 9.4 V3 Jenkins state mapping

Poll `<job>/lastBuild/api/json` every ~10 s (configurable):
`building==true` → **Working**; `SUCCESS/UNSTABLE/FAILURE/ABORTED/NOT_BUILT` → **Waiting** (a failed pipeline
needs the user but isn't *asking* Octopus for anything → not Blocked); a pipeline **Input step**
(`PAUSED_PENDING_INPUT`, via `/wfapi/describe`) → **Blocked**. Never `Unknown` after the first successful
poll.

---

## 10. Versioning Roadmap

**Principle:** define interfaces/enums in V1; add *implementations* in V2/V3. Signatures never change across
versions.

### V1 — Tasks, Sessions, Progress window, Terminal (no state)

- **Domain:** `Task`, `Session`, `WorktreeRef`, `Workspace`, both state machines. Also define
  `SessionState`/`TaskState`/`TaskStateAggregator` — but everything is `Unknown` and the UI renders **no
  icons**.
- **Application:** `CreateTask`, `DeleteTask`, `SwitchTask`, `OpenSession`, `CloseSession`, `ReorderSession`;
  single-writer command loop; `EventBus` that already carries `sessionStateChanged` (emitted by nobody yet).
- **Ports/Adapters:** `WorktreeProvider` + `SelectingWorktreeProvider` (composing `ScriptWorktreeProvider` +
  `NativeGitWorktreeProvider` — repo-local script or native git behind one port), `ScriptRunner`,
  `SessionManager`/`SessionRuntime`+`PtyTerminalRuntime`, `WorkspacePersistence`+`SqliteStore`,
  `IdGenerator`, `Clock`, `EventBus`.
- **UI:** ProgressPanel (task list, New/Delete Task), TaskWorkspace (tabs, registry-driven New-Session
  dropdown), TerminalPane + Terminal `SessionViewFactory`, keep-alive-on-switch.
- **Seams to leave (explicit):** `capabilities.EvaluatesState` (Terminal off); `stateEvaluator()` returns
  null; `EventBus` carries state events (dormant); aggregator called but yields `Unknown`; view resolution
  already keyed by `typeId`; `SessionConfig` already validated against `configSchema`;
  `OCTOPUS_STATE_SOCKET` env + per-session socket dir provisioned (unused); `CredentialsProvider` port shape
  defined.

### V1.5 — Multiple windows

Ships on top of feature-complete V1; **strictly additive** — no domain/port/IPC signature changes, only new
fields, commands, events, and one schema migration. Each layer's addition:
- **Domain:** `WindowId` branded id + `MAIN_WINDOW_ID` constant; `Session.windowId` field +
  `assignToWindow()`; `windowId` in `SessionSnapshot`. No aggregate/invariant changes (§3.7, I18).
- **Application:** commands `createWindow`, `closeWindow`, `moveSessionToWindow`, `createWindowWithSession`
  (+ their use cases + command-loop cases); `windows` + `thisWindowId` added to the `getState` read model
  (sessions returned unfiltered — the renderer filters by `windowId`).
- **Ports/Adapters:** `loadWindows/upsertWindow/deleteWindow` on `WorkspacePersistence` + `SqliteStore`;
  schema **v3→4** migration (`window_id` column + `windows` table + seed main, §6.3).
- **Infra/IPC:** `WindowRegistry` (replaces the single-target forwarder, §6.7); new channels + `windows`
  API group + synchronous `app.getWindowId()`; `WindowDTO`/`WindowedWorkspaceStateDTO`; three new events.
- **UI:** main/secondary `App` split; `SecondaryWorkspace`; New Window button; cross-window detach DnD
  (§5.6). `pty-router`/`webgl-budget` need **no** change (per-renderer-process singletons already correct).

**Forward-compatibility.** V2 is unaffected: status icons (§9) render per-session in whatever window hosts
the session; `sessionStateChanged/taskStateChanged` are broadcast to all windows. The V2 durable-session
daemon (§6.2) stays compatible — it echoes `windowId` on each event to route to the right window. V3 (Jenkins)
is untouched: a `JenkinsPane` carries a `windowId` like any session and moves between windows the same way.

### V2 — Session state + aggregation + icons

- Implement `TerminalHeuristicProvider` (OSC 133 + tcgetpgrp + activity) and `ClaudeCodeProvider`
  (socket/OSC 9000); flip Terminal's `EvaluatesState` on; inject OSC 133 integration into Octopus terminals.
- Wire the existing `sessionStateChanged` → ingest → `TaskStateAggregator` → view-model → icons in the
  progress window and on tabs. Debounce/hysteresis (§9.3). Add the state transition log + debug overlay.
- **No new ports, no domain signature changes.** Optionally expose the alternate aggregation precedence as a
  setting. *(Optional V2 infra:* migrate `SessionManager` to a durable backend — daemon/tmux — if
  process-survival is prioritized; renderer unaffected.)*

### V3 — Jenkins Pipeline Viewer

- Add `JenkinsClient` port + `JenkinsHttpClient` adapter (auth via `CredentialsProvider`/keychain — never
  plaintext). Add `JenkinsSessionTypeProvider` (`EvaluatesState` on, config schema job/branch/creds) +
  `JenkinsViewFactory` + `JenkinsProvider` state mapping (§9.4). Register at the composition root; dropdown
  and aggregation pick it up automatically. **Zero changes** to Domain, Application use cases, Terminal, or
  the aggregator.

---

## 11. Cross-Cutting Concerns & Risks

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | Terminal state-detection reliability (heuristics misfire) | High | OSC 133 injected by default; Claude Code hooks for authoritative Blocked; manual "refresh state" affordance; log every transition w/ layer+confidence to tune thresholds. |
| R2 | PTY performance with many sessions | Med | Single epoll loop; output batching (leading-edge + 3 ms trailing coalesce, §6.6); 200 ms tcgetpgrp off the hot path; O(1)/byte OSC parse; 20 sessions ≈ 100 syscalls/s — negligible. |
| R3 | Worktree provisioning safety (repo-local script **or** native git) | High | Validate the resulting path (absolute, exists, is a directory; warn if not a git worktree); containment check before delete (exactly the stored path, not `/`/`repoDir`/an ancestor); 30 s timeout; show command output; **all inputs passed as argv — no shell interpolation** for both scripts and native git (I17). |
| R4 | Keeping many sessions alive / crash loses agent work | Med | V1 accepts loss + fresh-shell restore; durable backend (tmux/daemon) is the V2+ mitigation behind `SessionManager`; warn on quit if Working/Blocked. |
| R5 | Security (air-gapped on-prem): socket spoofing, secrets | Med | Per-user `chmod 700` socket dir; validate/size-cap socket messages; secrets only via keychain (`credentialsRef`), never in the store/JSON. |
| R6 | OSC parsing correctness on adversarial output | Low–Med | Reuse a hardened parser (xterm.js's); cap param length (1 KB) + sequence timeout; never propagate parse errors to the renderer. |
| R7 | State flicker | Med | Debounce/hysteresis (§9.3); Blocked exempt (must be instant). |
| R8 | (V1.5) Cross-window move race — window moved between drop and `windowAtPoint`, or overlapping unmount/mount | Low | Hit-test is best-effort; worst case the session lands in the wrong window and is re-draggable. Source/target renderers are separate processes, so a brief double-sink during the move overlap cannot collide; the `pty-router` pending buffer covers the pre-mount gap (§6.7). |
| R9 | (V1.5) Quit blocked by the secondary-window close dialog | Low | `before-quit` sets an `isQuitting` flag; the secondary `close` handler skips its dialog when quitting, so `Ctrl+Q` runs the normal graceful shutdown (§6.7). |
| R10 | (V1.5) Persisted window off-screen after a monitor change | Low | On restore, clamp any window intersecting no display work area to the nearest display (`screen.getAllDisplays()`), preserving size (§6.3). |

**Observability:** structured JSON state-transition log at `~/.local/share/octopus/state.log`;
keyboard-toggled debug overlay showing the last N transitions per session (source layer + reason).

**Testing strategy:** unit (OSC parser byte-sequences, aggregation combinations, debounce timing — all pure);
integration (scripted PTY emitting OSC 133 at known times; `sleep` as foreground → assert Working; direct
socket writes → assert Blocked); e2e (real Claude Code with hooks → assert Working/Blocked); failure
injection (socket disconnect, no OSC 133 → assert graceful fallback). Worktree scripts tested against a
throwaway repo with a fake create/delete script.

**Performance targets:** PTY read→render <5 ms; OSC 133→state <10 ms; hook→state <20 ms; Blocked→task icon
<50 ms (debounce-exempt); Working→Waiting <1.5 s; Jenkins poll 10 s; state subsystem <1 MB/session.

---

## 12. Resolved Decisions

These were reviewed and decided; recorded here so implementation doesn't re-litigate them.

1. **Auto-inject OSC 133 & Claude Code hooks — YES, opt-out.** Octopus injects OSC 133 via an `--rcfile` that
   sources the user's own rc first (never edits `~/.bashrc`) and writes hooks into
   `<worktree>/.claude/settings.json`, **merging with — never clobbering — an existing file**. This is what
   makes V2 state icons work out of the box instead of requiring every developer to hand-configure their
   shell. The V1 seam (per-session socket + `OCTOPUS_STATE_SOCKET`) is provisioned regardless; injection
   itself lands in V2.
2. **Durable backend (survive app restart) — deferred to V2, behind `SessionManager`.** V1 hosts PTYs
   in-process and restores fresh shells at the correct cwd on restart. The `SessionManager` port boundary is
   kept clean enough that swapping in a tmux/daemon backend is drop-in. Pull it earlier only if long-running
   agents surviving crashes becomes a priority; tmux is the recommended backend (persistence + re-attach for
   free).
3. **Task creation collects four inputs via a modal.** Name, repo directory (native OS directory picker),
   source branch, and new branch (prefilled with a slug from the name, e.g. `feature/add-feature-1`; editable).
   All are passed to native git / the repo-local create script. This replaces the earlier "name + optional
   branch, script owns everything" decision: making the repo, source, and target explicit is what makes
   provisioning clear and self-service. No branch-naming policy is baked in beyond the editable prefill.
4. **Octopus owns worktree provisioning by default, with a repo-local script escape hatch.** When a repo has
   no `create_worktree.sh`/`delete_worktree.sh`, Octopus creates/removes the worktree natively via `git`,
   placing new worktrees under a configurable base dir `worktree.location` (default `~/octopus_repos/`). When
   those scripts *do* exist in the chosen repo directory, Octopus runs them instead and stores the path they
   return verbatim — so a team needing custom logic (special layout, submodules, LFS) keeps full control.
   Either way `repo_root` is stored **per task**, so multi-repo workspaces work with no special support:
   different tasks may target different repos. `OCTOPUS_REPO_ROOT` (= the task's repo dir) is passed to both
   paths (§6.4).
5. **Multiple windows (V1.5) — main + secondary, synced on one active task.** The main window owns the
   progress panel; secondary windows are session-only. All windows share the single `activeTaskId`, so
   switching a task switches sessions in every window. Session→window is an opaque `windowId` on `Session`
   (default `MAIN_WINDOW_ID`); window bounds live only in persistence. Cross-window DnD is *detach +
   drop-on-window* (§5.6). Closing a secondary window with live sessions asks (move-to-main vs kill); closing
   the main window quits the app. Windows + assignments restore on relaunch, with off-screen clamping (§3.7,
   §5.6, §6.7, I18).
