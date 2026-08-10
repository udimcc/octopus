# Project Octopus — Technical Design Document

> **Status:** Draft for review · **Companion to:** [`PRD.md`](./PRD.md)
> This document turns the product requirements into an implementable architecture. It defines the
> domain model, the layering, the technology stack, the process/PTY backend, the session-state-detection
> subsystem, and a phase-by-phase build plan with the seams that keep future work additive.

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
3. **Additive phasing** — phase 1 ships without painting into a corner; phase 2 (state) and phase 3 (Jenkins) add
   *implementations* behind interfaces defined in phase 1, not rewrites.
4. **Safety of destructive operations** — worktree create/delete run user scripts guarded by validation,
   containment checks, and strict teardown ordering.

### 1.2 Resolved ambiguities & key decisions

| Item | Resolution | Where decided |
|---|---|---|
| PRD line 39 tags Jenkins "Phase 2+", but §Phases says phase 3 | **Jenkins is phase 3.** Phase 2 is *state only*. | §10 |
| Desktop runtime / UI stack (was open) | **Electron + React + TypeScript.** | §4 |
| Quit semantics (was open) | **Persist metadata + gracefully terminate processes; do not resurrect live process state.** Reconcile worktrees on startup. | §7, §8 |
| PTY hosting: in-process vs daemon vs tmux | **Phase 1: node-pty in-process behind a `SessionManager` port.** Durable backend (daemon or tmux) is a phase 2+ migration with the same message protocol. | §6.2 |
| Task-state aggregation rule | **Worst-status-wins:** `Blocked > Working > Waiting > Unknown`. | §3.4 |
| Status vocabulary (one, shared) | **UI and domain share ONE vocabulary: `Unknown` / `Idle` / `Working` / `NeedsInput`** — no domain-vs-label translation. The enum *member names* are these; the enum **values** stay the original wire strings (`'waiting'`/`'blocked'`) so IPC, the daemon protocol, persistence, and hook payloads need no migration (§10's "signatures never change" holds — only TS member identifiers changed). `Unknown → no icon`. | §3.3, §5.4 |
| "Just finished" signal (many parallel agents) | **Ready-for-review is a renderer view-model flag, not a domain state.** A `Working→Waiting` transition observed while a session is unfocused raises a highlight that clears on focus. Adds **no** enum member, no port change. The displayed icon (session and task) is a single **display-state** priority — `NeedsInput > Review > Working > Idle > None` — that folds the flag into the state ordering; review is valid **only while the session is Idle**, so a newer `Working` supersedes a stale flag (a running session never shows the static review dot). | §3.4, §5.4, §9.5 |
| How status is detected | **Claude-only, out-of-band via a python bridge.** A single stdlib-only python3 script wired into Claude's hooks + statusline writes each session's state file (keyed by `OCTOPUS_SESSION_ID`); Octopus never reads the PTY or process table. Non-Claude foreground programs stay `Unknown` (no heuristic). | §9.1, §9.2 |
| Where state is *detected* (daemon vs main) | **Backend-agnostic: neither the runtime nor the daemon participates.** The bridge runs as Claude's own subprocesses; one app-side `ClaudeStateWatcher` (Electron main) file-watches the state dir and feeds `ingestSessionState`. Identical for the in-process and daemon backends — `SessionRuntime` has no state seam, the protocol has no state message. | §9.3, §9.6 |
| Worktree provisioning | **Repo-local script if present, else native git.** If `<repoDir>/create_worktree.sh` (resp. `delete_worktree.sh`) exists, Octopus runs it (script owns the location); otherwise Octopus provisions the worktree itself via `git worktree`. Detected **per task** on each create/delete. | §6.4, §12.4 |
| Worktree location | **Octopus-owned by default**, under a configurable base dir `worktree.location` (default `~/octopus_repos/`). A repo-local create script may return any location instead; Octopus stores the path verbatim. `repo_root` stored per task, so multi-repo works with no special support. | §6.3, §6.4, §12.4 |
| State-signal injection (Claude hooks + statusline) | **Opt-out auto-injection on startup** (`~/.claude/settings.json` merged, never clobbered — `#octopus-state`-tagged hook entries + a statusline that chains to the user's original). Lands in phase 2. | §9.2, §12.1 |
| Task-creation inputs | **Modal collects name, repo directory (native picker), source branch, new branch** (new-branch prefilled with a slug). All are passed to native git / the repo-local create script. | §5.4, §12.3 |
| Single vs multiple windows | **Multi-window, phase 1.5.** The **main** window owns the progress panel; **secondary** windows are session-only. All windows sync on the single `activeTaskId` (switch a task → sessions switch everywhere). Session→window is an opaque `windowId` on `Session` (default `MAIN_WINDOW_ID`); pixel bounds live in persistence only, never the domain. Windows + session assignments are restored on relaunch. | §3.7, §5.6, §6.7, §10 |

---

## 2. Architecture at a Glance

```
┌───────────────────────────────────────────────────────────────────────────┐
│ MAIN RENDERER (React)          │  SECONDARY RENDERER* (phase 1.5, one per window) │
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
│   WindowRegistry (phase 1.5): windowId → webContents; routes events per window     │
│   Ports → Adapters:                                                           │
│     WorktreeProvider → SelectingWorktreeProvider (Script | NativeGit)         │
│     SessionManager / SessionRuntime → PtyTerminalRuntime (node-pty)           │
│     WorkspacePersistence → SqliteStore (better-sqlite3)                        │
│     ClaudeStateWatcher (phase 2) → file-watches the python bridge's state dir      │
│     JenkinsClient (phase 3) → JenkinsHttpClient                                     │
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
  derived: TaskState     (phase 2+, computed from child session states)

Session (entity inside the Task aggregate)
  * ── 1 SessionType     (by typeId → resolved via registry)
  1 ── 1 SessionConfig   (type-specific value object; fully serializable)
  1 ── 0/1 RuntimeHandle  (opaque id into infra; not the process object)
  attribute: SessionState (phase 2+)
```

**Aggregate boundaries.** `Task` is the consistency boundary for its sessions (all add/remove/reorder/state
changes go through it, and it recomputes `TaskState`). `Workspace` is the boundary for tasks and the single
active-task pointer. **Cross-aggregate references are by id only** (never object pointers) — this keeps
persistence, event routing, and any future multi-window refactor clean.

### 3.2 Entities & value objects

- **Workspace** — `tasks: OrderedMap<TaskId,Task>`, `activeTaskId: TaskId?`, `config: WorkspaceConfig`. Owns
  the "at most one active task" rule.
- **Task** — `id`, `name` (display only), `worktree: WorktreeRef`, `sessions: OrderedList<Session>`,
  `activeSessionId?`, `lifecycle: TaskLifecycle`, `state: TaskState` (derived, phase 2+), timestamps.
- **Session** — `id` (globally unique), `taskId`, `typeId`, `title`, `config: SessionConfig`,
  `lifecycle: SessionLifecycle`, `state: SessionState` (phase 2+, default `Unknown`), `runtimeRef?`, `order`,
  `windowId: WindowId` (phase 1.5; which window renders it, default `MAIN_WINDOW_ID`; §3.7). `windowId` is an
  opaque assignment tag orthogonal to `taskId` — moving a session between windows never changes `taskId`
  (I7) or lifecycle (I9), so it is **not** a cross-aggregate object reference, just a presentation label.
- **WorktreeRef** (immutable once set) — `path: AbsolutePath`, `branch?` (the new branch), `baseRef?`
  (the source branch it was cut from), `managed: boolean`, `provisionedBy: ScriptInvocationMeta` (whose
  `repoRoot` is the per-task repo directory). `branch`/`baseRef` are populated from the create modal (§5.4);
  a repo-local create script that ignores them may still leave them set to the requested values. `managed`
  records ownership for the delete path (§6.4): `true` when Octopus provisioned the worktree ("From New
  Worktree" → removed from disk on delete), `false` when the task merely adopted an existing directory
  ("From Existing Repo" → left on disk on delete). Provisioning *status* lives in `TaskLifecycle`, not here.
- **SessionType** (registry descriptor, behavior not data) — `typeId`, `displayName`, `icon`,
  `availableFromVersion`, `configSchema`, `capabilities: Set<Capability>`, runtime factory reference.
- **SessionConfig** — per-type, validated against the type's `configSchema`. Must be fully serializable so a
  session can be recreated on restart. Terminal: `{ shell?, initialCommand?, cwdOverride? }` (defaults to the
  worktree path). Jenkins (phase 3): `{ jobPath, branch (defaults to worktree branch), credentialsRef }`.

### 3.3 State enums

```
enum SessionState { Unknown, Idle, Working, NeedsInput }   // + internal sub-states, §9.1
enum TaskState    { Unknown, Idle, Working, NeedsInput }   // derived only
```

The domain and the UI share **one** vocabulary — there is no relabeling layer. The mental model is *many
parallel agents, which one needs me?*:

| `SessionState`/`TaskState` | Meaning | Icon (§5.4) |
|---|---|---|
| `Idle` | alive, at a prompt, no command running | hollow/pause, gray |
| `Working` | a command is running / an agent is thinking | spinner, blue |
| `NeedsInput` | stopped, waiting on the *user* to continue (e.g. permission prompt) | warning, amber |
| `Unknown` | not yet evaluated / not Claude | no icon (transparent) |

The enum **member names** are this shared vocabulary; the enum **values** stay the original wire strings
(`Idle = 'waiting'`, `NeedsInput = 'blocked'`, plus `'working'`/`'unknown'`), so the `sessionStateChanged` wire
payload, the daemon protocol, persistence, the hook payloads, and the aggregation lattice are all untouched —
only the TypeScript identifiers changed (§10 holds).

Internal-only session sub-states (feed confidence scoring, not the UI): `Waiting/AtPrompt`,
`Waiting/Explicit`, `Working/Explicit`, `Blocked/Permission`, `Blocked/Explicit`, `Initializing` (mapped to
`Working` for display). See §9.

### 3.4 Task-state aggregation (phase 2+)

**Rule — worst-status-wins**, a pure `max` over the lattice `NeedsInput > Working > Idle > Unknown`:

```
aggregate(sessions):
    known = [s for s in sessions if s.state != Unknown]
    if known is empty: return Unknown          # empty task or all-unknown → Unknown (no icon)
    if any s.state == NeedsInput: return NeedsInput
    if any s.state == Working: return Working
    return Idle
```

**Justification.** The icon exists to direct attention across many parallel tasks. `NeedsInput` demands action
(highest); `Working` means "in flight, no action" (middle); `Idle` means idle-needs-command (low);
`Unknown` is transparent so an un-evaluated terminal never masks a blocked build. The reduction is total,
associative, and commutative → order-independent, incrementally recomputable, trivially testable.

**Pluggability.** Implement as a `TaskStateAggregator` strategy so the alternative "Idle > Working"
precedence can be offered as a setting without touching the `Task` entity. Empty task → no icon (never
`Idle`, which would imply the user has something to act on).

**Ready-for-review (a view concept, not a state, §9.5).** The `SessionState` lattice deliberately has **no**
"just finished" member — a finished agent is simply `Idle`. "This agent completed while I wasn't
looking" is instead a **renderer-side view-model flag** derived from the *transition* `Working → Idle`
observed while the session is **not focused**. It is not persisted, not aggregated by the domain, and never
enters `sessionStateChanged`; it is pure UI memory (§9.5). The flag clears on focus.

**The displayed icon is a single display-state priority, not `(worst-wins state) + (separate OR flag)`.**
Both the per-session tab icon and the per-task rollup resolve to one `DisplayState` — `NeedsInput > Review >
Working > Idle > None` (highest wins) — computed by folding the flag into the state ordering
(`sessionDisplayState`), then taking the **max** over a task's sessions (`taskDisplayState`). Two rules fall
out of this and are load-bearing:

- **Review is valid only while Idle.** `sessionDisplayState` maps a session to `Review` *only* if its
  current aggregation state is `Waiting` and the flag is set; a `Working`/`Blocked` session ignores the flag
  entirely. So a session that finished-then-resumed (`Working → Waiting → Working`, raising the flag on the
  middle step) displays `Working` — the newer state **supersedes** the stale flag. The earlier design, which
  ORed a `taskReadyForReview` flag independently of the worst-wins `TaskState`, showed the *static* review dot
  on a session that was actually running (a stable green dot while Claude was working) until focus cleared the
  flag. Computing the rollup from per-session display levels removes that class of bug and also lets `Review`
  on one session coexist with `Working` on another (the task shows the higher-priority `Review`).
- **NeedsInput outranks Review.** A blocked session in a task demands action before a finished sibling wants a
  look, so `NeedsInput` wins the rollup over `Review`.

Defense-in-depth: the store also **clears** the flag when a session leaves `Waiting` (e.g. `Waiting →
Working`), so the store stays honest and the debug read-out isn't misled — but correctness does not depend on
it, because consumption is gated by `sessionDisplayState` regardless.

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

`SessionLifecycle` ("is the runtime alive?") is **orthogonal** to `SessionState` ("what is it doing?", phase 2+).
Switching tasks never changes lifecycle — background sessions stay `Running`; visibility is a UI concern, not
a domain state. A `StartFailed`/`Exited` session maps to `Blocked` for aggregation.

### 3.7 Window model (phase 1.5)

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
│   └── TaskList → TaskListItem*  (TaskStatusIcon [phase 2] + label)
└── TaskWorkspace
    └── TaskView*                 (one per task; only active is visible)
        ├── SessionTabBar → NewSessionDropdown, SessionTab* (SessionStatusIcon [phase 2])
        └── SessionPaneArea → SessionPane*  (TerminalPane | JenkinsPane [phase 3])
```

All `TaskView`s and their `SessionPane`s stay mounted; only the active ones are visible (see §5.3).

### 5.2 State management & data flow

Zustand store holds: `tasks`, `sessions`, `activeTaskId`, `activeSessionId` (per task), and (phase 2) each
session's `state` (already a field on `SessionDTO`/`TaskEntry` — the phase-1 seam, always `'unknown'` in
phase 1) plus a `readyForReview` map and the `sessionDisplayState`/`taskDisplayState` selectors that fold it
into the §3.4 display-state priority (§9.5). **High-frequency `ptyData` bypasses the store** — it is delivered by IPC directly to the
target `TerminalPane`'s `terminal.write(data)`. On startup the renderer calls `app:getState` (§6.5) to
hydrate; thereafter lifecycle/status events patch the store. The store already has `reduceEvent` cases for the
dormant `sessionStateChanged`/`taskStateChanged` events (patching `sessions[id].state` / `tasks[id].state`) —
phase 2 only makes them fire and adds the `readyForReview` bookkeeping off the same `sessionStateChanged`.

```
Keystroke:  xterm onData → octopusAPI.pty.input → ipcMain → pty.write
Output:     pty onData → (batched, §6.5) → webContents.send('pty:data') → terminal.write   [not via store]
New task:   modal → octopusAPI.tasks.create → provision worktree (script or native git) → persist → resolve → store.createTask
Status(phase 2): evaluator (main, or octopusd→CONTROL) → ingest → sessionStateChanged → store patches
                 session.state (+ taskStateChanged) → TaskStatusIcon/SessionStatusIcon re-render;
                 Working→Idle on an unfocused session → store.readyForReview[id]=true → green check
```

### 5.3 Keep-alive on task switch (critical)

**Chosen approach: mount all sessions, toggle visibility via CSS.** Each `xterm.Terminal` is created once
(in a `useRef`, `useEffect([])`) and never destroyed until the session closes. Hidden sessions use
`visibility:hidden; position:absolute; width/height:0` — **not `display:none`** (which drops the WebGL
context). `terminal.write(data)` keeps running for hidden sessions so their buffer stays current.

- **On show:** `fitAddon.fit()` → `pty:resize` → `terminal.refresh(0, rows-1)` → **restore scroll**. The
  restore is required because the `width/height:0` hide (above) makes a re-shown xterm viewport fire a spurious
  `scrollTop=0` DOM event, which xterm's `_handleScroll` maps to `ydisp=0` (scrolled to top); xterm's own guard
  only fires for `display:none`, not our hide. So the pane captures its pre-hide scroll position on hide and
  re-pins on show (to the bottom if it was at the bottom — following new output — else to the exact line).
- **On hide:** capture the terminal's scroll position (`viewportY`/`baseY`) for the on-show restore; PTY and
  buffer remain live.
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
- **New Task:** modal with two tabs and an info button (top-right) whose hover/focus tooltip explains the
  active tab's delete behavior. **From New Worktree** (default): four fields — **name**, **repo directory**
  (a native OS directory picker via a `dialog:pickDirectory` IPC), **source branch**, **new branch**
  (prefilled with a slug from the name, editable); Octopus provisions a fresh worktree (`managed: true`).
  **From Existing Repo**: **name** + an existing **repository directory** Octopus adopts as-is (git detects
  its owning repo + branch; the repo's main checkout is allowed), stored `managed: false`. "Create Task" →
  spinner while the worktree is provisioned/adopted (repo-local script or native git, §6.4) → on success new
  task becomes active with empty state; on failure show stderr in a red block + Retry + toast.
- **New Session:** dropdown populated from the session-type registry (filtered by `availableFromVersion ≤
  currentVersion`). Terminal creates immediately; Jenkins (phase 3) opens a small config modal.
- **Delete Task:** confirm dialog whose body reflects ownership (§6.4) — a managed worktree "closes all
  sessions and removes the worktree", an adopted repo (`managed: false`) "closes all sessions" but leaves
  the directory on disk; on dirty worktree, an extra "uncommitted changes — delete anyway?" confirmation
  (the dirty gate still fires for adopted repos, even though nothing is removed from disk).
- **Status icons (phase 2):** shape **and** color (accessibility), rendered per session on its tab
  (`SessionStatusIcon`) and per task in the progress panel (`TaskStatusIcon`). Icons follow the §3.3
  vocabulary: **Idle** = hollow/pause, gray; **Working** = spinner/filled, blue;
  **NeedsInput** = warning triangle, amber; **Unknown** = no icon at all (transparent, never a
  placeholder glyph — an un-evaluated session must not draw attention). Tooltips give the plain-text label +
  reason (e.g. "Needs input — Claude is asking permission to run a tool").
  - **Ready-for-review highlight (§3.4, §9.5):** an *idle* session flagged ready-for-review shows a distinct
    **static accent dot** in place of the plain gray idle icon — visually the Working dot **without** the
    pulse, so "done, wants your eyes" reads apart from "still running" at a glance. On a task the same accent
    decorates the rollup icon. It is the "which of my agents finished?" scan signal, resolved through the
    single display-state priority (`NeedsInput > Review > Working > Idle`, §3.4): a session that has resumed
    `Working` shows the pulsing Working dot, never the static review dot. Clearing is on **focus** of that
    session (opening its tab in its window). Because it is a renderer view-model flag it survives task switches
    (still in the store) but not an app restart (a restored session starts un-flagged — a finished-long-ago
    agent is just idle).
- **Keyboard:** eight actions are **fully user-configurable chords** in Settings — next/prev session
  (`sessionNextKey` / `sessionPrevKey`, defaults `Ctrl+Shift+→`/`←`), next/prev task (`taskNextKey` /
  `taskPrevKey`, defaults `Ctrl+Shift+↓`/`↑`), new session (`newSessionKey`, default `Ctrl+Shift+N`), new task
  (`newTaskKey`, default `Ctrl+Shift+T`), close session (`closeSessionKey`, default `Ctrl+Shift+W`), and
  terminal search (`searchKey`, default `Ctrl+Shift+F`) — each bound independently (no "opposite" is
  inferred). A capture accepts any key but is validated to require ≥1 modifier (so it can't shadow a bare
  terminal keystroke) and is checked for conflicts against every other configurable chord (and
  `RESERVED_CHORDS`, currently empty) before Save is allowed. `Ctrl+Shift+C/V` copy/paste and `Esc` close
  modal/dropdown are not configurable. Because every binding requires a modifier, terminal `Ctrl+C` etc. are
  never stolen. `TerminalPane` also installs an xterm `attachCustomKeyEventHandler` that drops both every
  `Ctrl+Shift` chord AND the eight configurable chords before they become PTY input, so a global shortcut is
  never *also* written to the terminal (the `window` listener's `preventDefault` alone is unreliable —
  xterm's textarea handler runs first).
- **Empty states & toasts:** "No tasks yet", "No sessions", inline "Connecting…" written into the terminal;
  bottom-right toasts for script failures, unexpected PTY exit, Jenkins errors (phase 3).

### 5.5 Renderer / main split

- **Main:** all node-pty instances, worktree script execution, IPC server, filesystem, persistence, state
  evaluators (phase 2), Jenkins HTTP client (phase 3). Source of truth for persisted state — survives renderer reload.
- **Preload:** exposes only a typed `window.octopusAPI` via `contextBridge`; renderer never touches
  `ipcRenderer`/Node directly.
- **Renderer:** rendering, Zustand store, xterm instances (in refs, never serialized to store), IPC
  subscription setup.

### 5.6 Multiple windows (phase 1.5)

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
         OCTOPUS_TASK_ID, OCTOPUS_SESSION_ID /* keys the Claude state file, §9.1 */,
         OCTOPUS_WORKTREE,
         /* stripped: TMUX, STY, WINDOWID */ } })
```

- **Shell:** setting `terminal.shell`, else `$SHELL`, else `/bin/bash`; login shell (`-l`) so profiles load.
- **cwd:** the task's worktree path (from the task record at session creation).
- **Resize:** `ResizeObserver` (debounced ~50 ms) → `fit()` → `pty:resize` → `pty.resize` → kernel
  `TIOCSWINSZ` delivers SIGWINCH automatically.
- **Exit:** node-pty `onExit` reaps the child (waitpid) → mark `Exited`, emit `sessionExited`, retain
  scrollback so the user can read final output.
- **Close:** SIGHUP; if still alive after 2 s, SIGKILL. (phase 2+: spawn each shell via `setsid` so SIGKILL to the
  group also kills descendants — compilers, agents.)
- **FD limits:** raise `RLIMIT_NOFILE` to 65536 at startup (default 1024 is exhausted by dozens of PTYs).

### 6.2 In-process vs daemon

**Two coexisting backends behind one `SessionManager` port, selected by the `terminal.backend` setting
(`'in-process' | 'daemon'`, default `'daemon'` — only an explicit `'in-process'` opts out).** The **renderer talks only to the `SessionManager`
interface and never changes** regardless of which backend is active — swapping the backend is a composition-root
concern (`SwitchableSessionManager`), invisible above the port.

**In-process** (`PtySessionManager`, PTYs owned by the Electron main process). Simplest, no extra
infrastructure. **Trade-off accepted:** an app/main-process crash orphans running processes; on restart Octopus
recreates *fresh* shells at the last-known cwd (metadata persists; live process state does not — I13).

**Daemon** (`DaemonSessionManager` + `octopusd`, implemented). PTYs are owned by a long-lived, **detached**
`octopusd` process that outlives the app, so an app restart **re-attaches** to still-running shells instead of
respawning them — carrying cwd, live foreground programs (vim/Claude/emacs), and scrollback across the restart.
The daemon keeps a server-side ring buffer (~5 MB/session) replayed on attach, and speaks the same
transport-agnostic protocol (`src/shared/node/daemon-protocol.ts`, length-prefixed frames over a per-uid Unix
socket in `/tmp/octopus-<uid>/` at mode 0700). It hosts **node-pty only** (N-API/ABI-stable → loads under
Electron-as-node via `ELECTRON_RUN_AS_NODE=1`); the SQLite DB stays in Electron main (Electron-ABI-only
prebuilt). **Durability is against APP restart, not daemon crash:** a daemon crash kills its child PTYs, and the
app then falls into the fresh-spawn path.

**Fallback (the chosen daemon-down policy).** With `backend='daemon'` but the daemon unreachable, the app
(re)launches a fresh daemon and spawns fresh at `last_cwd`; only if the daemon *launch itself* fails does it
degrade to in-process for that run. This is why both backends coexist and rollback is trivial — flip the setting
back. tmux remains a possible alternative durable backend but is not implemented.

### 6.3 Persistence

**SQLite** at `$XDG_DATA_HOME/octopus/octopus.db` (Linux) / `%APPDATA%\octopus\octopus.db` (Windows). Global
settings in a sibling `settings.json` (small, human-editable). Schema (simplified):

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, worktree TEXT NOT NULL, branch TEXT,
  base_ref TEXT, repo_root TEXT, created_at INTEGER NOT NULL, position INTEGER NOT NULL,
  active_session_id TEXT, managed INTEGER NOT NULL DEFAULT 1);  -- branch=new branch, base_ref=source branch, repo_root=per-task repo dir (all nullable); managed=1 provisioned / 0 adopted (§6.4)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL, label TEXT NOT NULL, shell TEXT, position INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown', created_at INTEGER NOT NULL, exited_at INTEGER,
  window_id TEXT NOT NULL DEFAULT 'main');  -- phase 1.5: which window renders it (§3.7); default = main
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- e.g. active_task_id
CREATE TABLE windows (  -- phase 1.5: window records incl. monitor placement (§3.7, §6.7)
  id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('main','secondary')),
  x INTEGER NOT NULL DEFAULT 0, y INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 1280, height INTEGER NOT NULL DEFAULT 800,
  created_at INTEGER NOT NULL);
```

**Persist:** task list/name/worktree/branch/base_ref/repo_root/order/active-session; session definitions
(id, type, label, shell, order, `last_cwd`); active task; global settings. **Cannot persist (in the Electron
process):** live PTY/TTY state and the foreground process. **Restore — attach vs fresh:** verify each worktree
path exists (else mark task `Stale` with a warning, don't start sessions); then for each terminal session the
backend decides:
- **Fresh spawn** (in-process always; daemon when the session's PTY is gone) — open a new PTY at the session's
  `last_cwd` if present (captured daemon-side on quit / roster refresh), else the config `cwdOverride`, else the
  worktree root. Persisted scrollback is metadata, independent of the live PTY (I13): it is loaded and published
  (as a `ptyData` event) **ahead of** the spawn, so restored history paints immediately without waiting on the
  shell fork. The configured `initialCommand` runs on a fresh spawn.
- **Re-attach** (daemon backend, when the session id is still in the daemon's live roster — `liveDaemonSessions`)
  — the daemon replays its own richer live ring buffer, so the persisted DB scrollback is **not** re-published
  (that would double-print history) and the `initialCommand` is **suppressed** (I15 — the process already exists
  and likely already ran it). The live cwd and foreground program come back with the process.

The `repo_root` column round-trips the per-task repo directory so delete-after-restart re-invokes the correct
repo-local script / git repo (§6.4).

**Schema version:** `PRAGMA user_version` is stamped with the current version. Adding `base_ref` bumped it
to **2**; `SqliteStore` runs a guarded, idempotent `ALTER TABLE tasks ADD COLUMN base_ref TEXT` when it
opens a `user_version < 2` database (§10 — this is the first use of the migration seam). Persisted scrollback
bumped it to **3**. **Phase 1.5 (multi-window) bumps it to 4:** a guarded `ALTER TABLE sessions ADD COLUMN
window_id TEXT NOT NULL DEFAULT 'main'` (the default migrates every existing session to the main window with
no UPDATE pass), a `CREATE TABLE IF NOT EXISTS windows`, and an `INSERT OR IGNORE` seeding the `main` window
record — the same fresh-DB-`CREATE`-plus-guarded-upgrade pattern proven at v2/v3. **Adopted-repo ownership
bumps it to 5:** a guarded `ALTER TABLE tasks ADD COLUMN managed INTEGER NOT NULL DEFAULT 1` plus a
back-fill `UPDATE tasks SET managed = 0 WHERE base_ref IS NULL` — historically only adopted tasks left
`base_ref` null, so this marks them unmanaged (left on disk on delete, §6.4) while every provisioned row
keeps the `DEFAULT 1`.

**Windows persistence (phase 1.5, §3.7, §6.7).** `WorkspacePersistence` gains `loadWindows/upsertWindow/
deleteWindow`. Window **bounds** are saved (debounced) on OS move/resize; the session's `window_id` is
saved via the normal `upsertSession`. **Restore:** at boot, main creates a `BrowserWindow` for every
persisted `WindowRecord` at its saved bounds, but **clamps off-screen bounds** — if a saved window
intersects no current display work area (`screen.getAllDisplays()`, e.g. a monitor was unplugged) its
top-left is snapped into the nearest display, preserving width/height. Each restored session then renders in
whichever window its `window_id` names (falling back to the main window if that window record is gone).

### 6.4 Worktree provisioning contract

Worktree create/delete go through the `WorktreeProvider` port. The phase 1 implementation is a
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

**Adopt ("From Existing Repo") and managed ownership.** A task may instead **adopt** an existing directory
(New-Task modal, §5.4). `NativeGitWorktreeProvider.adopt` runs read-only `git -C <dir> worktree list
--porcelain` (first entry = repo root, stored for delete-safety) + `rev-parse` for the branch, and stores
`managed: false`. The repo's **main working tree is allowed** here (`repoRoot === path`): because an adopted
worktree is `managed: false`, `deleteTask` **skips the `remove` call entirely** — the containment check
(step 1 above) is never reached, and the directory Octopus never created is left on disk. A provisioned
worktree is `managed: true` and deletes exactly as before. The dirty gate (step 2) still runs for adopted
repos so the user is warned about uncommitted changes, even though nothing is removed.

### 6.5 IPC protocol

**Phase 1 transport:** Electron `contextBridge` + `ipcMain`/`ipcRenderer`, all behind the typed `octopusAPI`.
Request/reply commands use `ipcMain.handle` (with a renderer-generated `requestId`); streaming `ptyData` uses
`webContents.send` to avoid head-of-line blocking. The message set is transport-agnostic so the phase 2 daemon can
carry it over a Unix socket unchanged.

```
Commands (UI→backend): createTask{name,repoDir,sourceBranch,newBranch}, deleteTask{force?},
  renameTask, reorderTask, createSession, closeSession, renameSession, reorderSession,
  writeToPty, resizePty, getState, updateSettings
Queries (UI→backend, no domain mutation): pickDirectory (native OS folder picker for the New-Task modal)
Events (backend→UI):  ptyData, sessionCreated, sessionExited, sessionClosed,
  taskCreated, taskDeleted, taskRenamed, taskStale, scriptProgress, scriptError,
  sessionStateChanged (phase 2), taskStateChanged (phase 2), error
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

### 6.7 Multi-window backend (phase 1.5)

**Event routing — `WindowRegistry`.** The single-target event forwarder (§6.5, one `webContents`) is
replaced by a **`WindowRegistry`**: a `Map<WindowId, { webContents, ready, pending[] }>` with **one** bus
subscription whose closure routes each mapped `EventDTO` by kind:
- **`ptyData` and session-scoped events** (`sessionCreated/Exited/Closed/Renamed/Reordered`) → **only the
  window hosting that session** (look up `session.windowId`; drop silently if the session is mid-close).
- **`sessionMovedToWindow`** (new) → **both** the source and target windows, so both re-render in one cycle.
- **Task-level / broadcast events** (`taskCreated/Deleted/Renamed/Reordered/Stale`, `activeTaskChanged`,
  `scriptProgress/Error`, `error`, settings, and the dormant phase 2 `sessionStateChanged/taskStateChanged`) →
  **all** windows — every window keeps its active-task view (and the main window its full task list) correct.

Each window identifies itself at creation via a `?windowId=<id>` URL param (§5.6). Per-window `markReady`
fires from that window's `getState` call — the handler resolves the caller via
`BrowserWindow.fromWebContents(e.sender)` — so each renderer's buffered startup events flush exactly when it
can receive them (generalizes the §6.5 single-window `onHydrate`).

**New protocol (transport-agnostic, §6.5 — the phase 2 daemon carries `windowId` unchanged):**
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
- **I13.** On quit the Electron process persists metadata only and never persists live *process* state; how
  runtimes are released depends on the backend. **In-process:** gracefully terminate (SIGHUP) — a fresh PTY is
  spawned on restart. **Daemon:** *detach* (do not kill) — the PTYs keep running in `octopusd`, which is a
  separate process, not persisted state; so a durable backend **may** retain live processes across an app
  restart and re-attach to them (§6.2). Absent a durable backend, restore opens a fresh PTY. **I14.** Worktrees
  persist on disk; on startup reconcile each task's worktree path (missing → `Stale`/degraded with re-provision
  or force-forget). **I15.** On restart, sessions are recreated from serialized `SessionConfig` (fresh terminal
  / fresh Jenkins viewer) — **except** when a durable backend re-attaches a still-live session, in which case
  the config is not re-applied (the process already exists; `initialCommand` is not re-run).
- **I16.** Never persist secrets. Jenkins config stores a `credentialsRef`; a `CredentialsProvider` port
  resolves it from the OS keychain (libsecret) at runtime. Define this port's shape in phase 1's persistence
  design so phase 3 doesn't retrofit secret handling.
- **I17.** User scripts, native `git` invocations, and terminal commands are a trust boundary: run via
  `ScriptRunner` with explicit cwd, **no shell-string interpolation of untrusted names** (branch names,
  paths, and repo dirs are passed as argv elements with `shell:false`), timeouts, captured exit/stderr.
- **I18.** (phase 1.5) A session has exactly one `windowId` at all times (default `MAIN_WINDOW_ID`); moving it
  between windows changes only `windowId`, never `taskId` (I7) or lifecycle (I9). A session whose persisted
  `window_id` names a window that no longer exists falls back to `MAIN_WINDOW_ID` on restore (never orphaned).
  On restore, windows and their session assignments are reconstructed alongside tasks/sessions (extends
  I13/I14/I15) — the Electron process still resurrects no live process state (fresh PTYs on the in-process
  backend; the daemon backend re-attaches to PTYs it kept running, I13).

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

**`SessionRuntime`** exposes `start()/stop()/dispose()` and a type-neutral output/interaction handle — it owns
only the PTY lifecycle, not state detection (§9.6). State is **push-based** but sourced OUT of the runtime: the
Claude python bridge writes each session's state file and the app-side `ClaudeStateWatcher` emits
`sessionStateChanged` on the `EventBus`; the Application ingests it and recomputes `TaskState`. `EvaluatesState`
survives as a session-type capability flag (Terminal advertises it), but there is no `stateEvaluator()` seam on
the runtime.

**Acceptance test for the abstraction:** adding Jenkins (phase 3) is a `JenkinsSessionTypeProvider` +
`JenkinsViewFactory` + a `JenkinsHttpClient` adapter, registered at the composition root — **zero edits** to
`Task`, the aggregator, or the dropdown logic. If adding a type required editing those, the abstraction is
wrong. Phase 1 uses static registration (Terminal only); dynamic/third-party plugin loading is deferred but
additive behind this registry.

---

## 9. Session-State-Detection Subsystem (phase 2 core)

Status reflects **only a program that reports its own state** — in practice Claude Code (§9.2). A bare shell,
or any other foreground command, is `Unknown` (no icon). State is sourced **out-of-band** from a single
self-contained python3 bridge that Claude itself runs (via hooks + statusline); Octopus never reads the PTY,
the process table, or a socket to compute state. The runtime/daemon do not participate at all (§9.6).

### 9.1 The state bridge (one script, three modes)

A single stdlib-only python3 script — `octopus-claude-state.py`, embedded as a string in
`src/adapters/claude/octopus-claude-state.script.ts` and written into the data dir on startup by
`ensureClaudeStateScript` (the same embed-and-write-on-boot pattern as the shell-integration rc files, chosen
over a bundled asset because electron-vite's `out/` vs `release/` layouts make an on-disk asset path fragile).
It owns **all** state logic and runs in three modes, all driven from `~/.claude/settings.json`:

- **`hook <Event>`** — wired to Claude's lifecycle hooks (§9.2). Maps the event to a state and records it as
  the session's `hook` observation.
- **`statusline`** — wired to `statusLine.command`. Derives state from the session TRANSCRIPT tail, records it
  as the `transcript` observation, THEN delegates to the user's ORIGINAL statusline command and prints its
  output verbatim (so the user's status bar is unchanged). This is the resume-recovery path: after `--resume`
  the prior process's hooks are gone, but the transcript survives.
- **`get <id>`** — prints the effective state (debug / tooling). Never fails: an unknown id prints `unknown`.

**Per-session state file.** Keyed by `OCTOPUS_SESSION_ID` (the env var Octopus injects into every managed PTY,
inherited by the hook/statusline subprocesses — so one global settings entry serves every session and every
worktree, and the script is a silent no-op outside an Octopus PTY). Written atomically (temp + `os.replace`)
to `<dataDir>/claude-state/<OCTOPUS_SESSION_ID>.json`:

```
{ state, reason, updated_at,
  turn_start_ts, turn_end_ts,               // turn boundaries (§9.1 turn gating)
  subagent_ids,                             // outstanding subagent agent_ids (primary path, §9.1)
  subagents,                                // anonymous fallback counter (no-SubagentStart versions, §9.1)
  has_subagent_start,                       // capability latch: SubagentStart seen this session (§9.1)
  stop_deferred,                            // a Stop was deferred pending subagents (§9.1)
  hook:       { state, reason, ts, event }, // last in-turn hook observation
  transcript: { state, reason, mtime } }    // last transcript-derived observation
```

**Effective state = newer-observation-wins** between `hook.ts` (wall-clock at hook time) and
`transcript.mtime` (the transcript file's mtime), tie → hook. Live, a hook fires at now ≥ the transcript
mtime, so hooks stay authoritative; after resume the transcript advances with no new hook, so it wins. There
is **no** fixed staleness window, **no** activity timing, and **no** silence-based heuristic — the two
observations are self-dating, so the newer one is simply trusted. One exception implements the §9.7 mid-tool
mitigation: a transcript-derived `blocked` is overridden by an in-turn `working` hook (the hook slot is
`working` and the turn is open), since a dangling `tool_use` mid-execution is indistinguishable from an
awaiting-permission one. A real permission prompt records a `blocked` hook, so it is unaffected; with no fresh
hook (resume), or a closed turn, the transcript still wins.

**Subagent gating (the fix for "delegating session reads done / flickers").** "State" means the *whole* Claude
session — the main agent **and** any subagents it spawns (foreground **or** background). A subagent inherits the
parent's `OCTOPUS_SESSION_ID`, so its own hooks write to the *parent's* state file. The bridge tracks each
subagent's true lifespan and, while **any** is outstanding **and the turn is open**, `effective()` forces
`working` regardless of either observation slot — so a session waiting on subagents never reads Idle (bug 1) and
never flickers done-then-working when a subagent returns and the main agent resumes (bug 2).

**Two tracking paths, one capability latch.** Octopus registers **both** `SubagentStart` and `SubagentStop` via
its own merge-safe injector (`HOOK_EVENTS`, §9.2) — never a hand-edit — so the signal is available on every
install without the user touching their Claude config. The bridge adapts to whichever the running Claude version
actually emits:
- **Primary — `SubagentStart` .. `SubagentStop`, paired by `agent_id`.** Both events carry `agent_id` (verified
  from live payloads), so outstanding children are an **id set** (`subagent_ids`), not a count. `SubagentStop`
  *removes* its id; a duplicate or cross-turn stop for an unknown id is a **no-op**, so it can never under-count
  a still-live child (this closes the stray-stop edge a bare counter had). `SubagentStart` also **latches**
  `has_subagent_start` (a session-lifetime flag), after which the fallback below stops counting so one launch is
  never counted twice. **Ordering reclaim:** the latch only blocks *future* `PreToolUse` — but live traces show
  `PreToolUse(Agent)` fires *before* `SubagentStart`, so the launch was already counted on the fallback by the
  time the latch is set. Because `PreToolUse(Agent)` is 1:1 with `SubagentStart`, when `SubagentStart` adds a
  **new** id it also decrements the anonymous counter by one (floored at 0), reclaiming that paired pre-latch
  increment. Without this a single background child reads `subagent_count == 2`, and after its `SubagentStop`
  clears the id the anonymous counter stays at 1 — so `subagent_count` never reaches 0, the deferred `Stop`
  never finalizes, and a fire-and-forget child leaves the session stuck `working` forever.
- **Fallback — `PreToolUse(Task|Agent)` .. `SubagentStop`, anonymous counter.** On a Claude version that emits
  **no** `SubagentStart`, `PreToolUse` for a delegation tool increments the `subagents` counter at launch and
  `SubagentStop` decrements it (floored at 0). This is the previously-verified model; it stays exactly correct
  when no `SubagentStart` is seen, so adding the primary path is a strict, no-regression superset. (If a version
  ever fires `SubagentStart` with no `agent_id`, that path degrades to this same anonymous counter.)

`subagent_count = len(subagent_ids) + subagents`; the two paths never both count the same child (the latch).

**Why the close bracket is `SubagentStop`, not `PostToolUse` (this was the background bug).** A *background*
subagent's `PreToolUse(Agent)` **and** `PostToolUse(Agent)` both fire at **launch** — the delegation tool
returns a handle immediately and the main agent moves on — so `PostToolUse` marks launch, not completion.
Keying the decrement to it left the counter at 0 for the child's entire run. Worse, Claude fires the main
agent's `Stop` as soon as *it* yields, typically **before** a background child ends; the old code closed the
turn and zeroed the counter there, flashing Idle mid-run. The fix: **`Stop`/`StopFailure` defers closing while
`subagents > 0`** — it records `working`, leaves `turn_end_ts` and the counter untouched, and sets a
**`stop_deferred`** flag so the pending close is remembered; the turn stays open and the override holds.

The turn then closes on **whichever comes first**:
- **the main agent resumes and `Stop`s again** — when a background child ends, the harness usually re-invokes
  the main agent to consume its result (a fresh `UserPromptSubmit`, which clears `stop_deferred`), and it later
  `Stop`s with `subagents == 0`, closing normally; or
- **the last child's `SubagentStop` finalizes the deferred `Stop`** — when the decrement drops the counter to 0
  *and* `stop_deferred` is set, the main agent had already yielded, so the whole session (main + all sub-calls)
  is genuinely finished: `SubagentStop` sets `turn_end_ts`, records `waiting`, and clears the flag → Idle.

The `stop_deferred` distinction is what makes `SubagentStop` correct in *both* directions: a `SubagentStop`
with **no** pending Stop means the main agent is still working, so it only decrements and stays Working (no
premature close, no bug-2 flicker in the common resume case where the child ends *before* the main agent
yields); a `SubagentStop` **after** a deferred Stop means the parent already finished and will not necessarily
resume, so it must close — otherwise a *fire-and-forget* child (parent never resumes) would leave the session
**stuck Working forever**, since the deferred `Stop` never re-fires and the `subagents == 0 … turn_open`
override blocks the transcript backstop. The residual bug-2 exposure is a sub-second, watcher-coalesced Idle
blip *only if* the main agent does resume after the finalize — strictly better than an unbounded silent
stuck-Working (see §9.7 edge 2).

Two deliberate constraints: (a) the override yields to a genuine `blocked` **hook** — if a subagent needs
approval the user must act, so that is NeedsInput, not Working; (b) it is turn-gated, so a leaked counter can
never stick a finished session Working past a *closed* turn. Self-healing on both edges: `UserPromptSubmit`
resets the counter to 0 (a missed `SubagentStop` cannot leak past the next prompt), and a stray `SubagentStop`
after a clean `Stop` (counter already 0) is out-of-turn, so the turn gate drops its write and `waiting` stands.
A legacy file with no `subagents` field reads 0 (override inert).

**Turn gating (the fix for "idle session flaps back to Working").** The hook slot holds the last *in-turn*
observation, not the last hook of any kind. A turn **opens** on `UserPromptSubmit` (`turn_start_ts`) and
**closes** on `Stop`/`StopFailure` (`turn_end_ts`); it is open iff `turn_start_ts > turn_end_ts`, and a
**missing `turn_start_ts` ⇒ closed** (so a legacy file, or one that has just seen a `Stop`, is closed). The
turn-boundary events always record; every other event is a *within-turn* observation and is honored **only
while the turn is open** — an out-of-turn one aborts the write, leaving the file untouched. Without this, a
stray `working` sub-event that Claude fires after a turn already ended (e.g. a `SubagentStop` arriving minutes
after `Stop` with no new prompt) would clobber the terminal `waiting` with a newer `working` and win the
newer-observation race against the frozen transcript — surfacing a finished session as Working. A blocked
event (`Notification`/`PermissionRequest`) is gated the same way: a real permission prompt only ever occurs
mid-turn, so gating never drops a genuine one but does drop a stray post-`Stop` one. Only start/end events move
the turn boundary; a permission request does **not** close the turn (Claude is still mid-turn, awaiting
permission), so mid-turn `SubagentStop`→Working (§9.2) is preserved.

**Mis-gate is self-correcting; the old bug was not.** The only new failure mode is dropping a legitimate
`working` sub-event because a turn's `turn_start_ts` was never recorded (a legacy/resumed file mid-turn). The
transcript backstop covers exactly this: during real work the statusline fires and `transcript.mtime` advances
to ~now, so the transcript observation reads `working` and wins; and the next `UserPromptSubmit` re-opens the
turn, bounding any mis-gate to the current turn. By contrast the bug being fixed (false-`working`-while-idle)
had **no** backstop — when idle the transcript is frozen at `waiting`, so nothing corrected a spurious
`working`. The fix trades an uncorrectable error for a correctable one.

### 9.2 Claude Code hook / statusline wiring (the only reliable `Blocked`)

"Blocked waiting for permission" is internal to Claude Code — no OS primitive exposes it (it is foreground,
has printed a prompt, and is reading stdin — indistinguishable from Waiting from outside). Solution: let Claude
tell us, via its own hooks and statusline, both pointed at the bridge (§9.1).

- Octopus merges into the user-global `~/.claude/settings.json` on startup (merge-safe + idempotent, tagged
  with `#octopus-state` so only Octopus's own entries are ever touched — see
  `src/adapters/claude/claude-hooks.ts`):
  - each wired lifecycle **hook** runs `python3 <script> hook <Event>`;
  - `statusLine.command` is repointed at `python3 <script> statusline`, after SAVING the user's original
    command (to `claude-state/original-statusline`) so the bridge can chain to it and the user's bar is
    unchanged.
- **Event → state map** (`HOOK_STATES`), interpreted through the turn gate (§9.1):
  - `Stop` / `StopFailure` → `waiting` (main agent finished → Idle; **closes** the turn) — **except** when a
    subagent is still outstanding (`subagents > 0`), where it records `working`, **defers** closing the turn,
    and sets `stop_deferred` (§9.1 subagent gating), so a background child outliving the main agent's turn does
    not flash Idle.
  - `UserPromptSubmit` → `working` (**opens** the turn; resets both `subagent_ids` and the `subagents` counter,
    clears `stop_deferred`; the `has_subagent_start` capability latch persists).
  - `SubagentStart` / `PreToolUse` / `PostToolUse` / `SubagentStop` → `working` (in-turn; a delegated subagent
    finishing does not by itself mean the MAIN agent is idle, so `SubagentStop`→Working — honored while the turn
    is open). Subagent bookkeeping (§9.1, two-path): `SubagentStart` (primary) adds its `agent_id` to
    `subagent_ids` and latches `has_subagent_start`; `PreToolUse` for a delegation tool (`Task`/`Agent`)
    increments the anonymous `subagents` counter **only until that latch is set** (fallback for versions with no
    `SubagentStart`); **`SubagentStop` removes** its `agent_id` (or decrements the counter) and, when
    `subagent_count` reaches 0 *while a Stop was deferred* (`stop_deferred`), **finalizes the deferred close** —
    sets `turn_end_ts`, records `waiting`, clears the flag → Idle. `PostToolUse` never touches subagent state —
    a background subagent's `PostToolUse(Agent)` fires at launch, not completion, so it cannot mark the close.
  - `Notification` / `PermissionRequest` → `blocked` (Needs input; in-turn) — EXCEPT the idle "waiting for your
    input" reminder Claude fires after a turn already ended, which the bridge suppresses (reads the payload on
    stdin; emits no write) so it can't overwrite `Stop`→Idle with a false Needs-input.
  - Any unlisted/renamed event → `working` (still the agent's turn; never mis-read as Idle).
- **Transcript inference** (`statusline` mode): a `tool_use` with no matching `tool_result` (dangling) →
  `blocked` — **except** when *every* dangling `tool_use` is a delegation tool (`Task`/`Agent`), which → `working`
  (the main agent is waiting on a subagent, i.e. the whole session is still working; this is the resume/no-hook
  path — live, the `subagents` counter already forces `working`). A mix of a dangling delegation call and a
  dangling non-delegation tool (a possible real permission prompt) still → `blocked`. Else the last assistant
  turn ended (`end_turn`/`stop_sequence`) → `waiting`; else → `working`.
- **Graceful degradation.** Every hook is `python3 <script> … 2>/dev/null || true` and the bridge wraps every
  write, so a failure is a silent no-op and the session stays `Unknown`. Nothing from Claude's payloads is ever
  executed; the bridge only reads/writes JSON.

Alternatives (inferior): parsing Claude Code's terminal output (brittle, version-coupled) or an Octopus MCP
server (richer but heavier — defer).

### 9.3 App-side consumer: the state watcher

The app half of the edge is `src/adapters/claude/claude-state-watcher.ts` — the **sole** source of session
state now. It watches the `claude-state/` dir and turns each `<id>.json` change into a
`(sessionId, SessionState, meta)` push:

- **Initial scan on construction** (resume recovery): replays every existing file so restored tabs show status
  immediately after an app restart, without waiting for the next hook.
- **`fs.watch`** for each subsequent write, per-file debounced (~40 ms) because an atomic temp+replace fires a
  rapid rename+change burst for one logical write.
- **Mapping.** `coreToSessionState` (`src/adapters/claude/core-to-session-state.ts`) maps the file's top-level
  `state` string to the domain enum: `waiting`→Idle, `working`→Working, `blocked`→NeedsInput, else→Unknown.
  The filename stem IS the `OCTOPUS_SESSION_ID`, which the app knows as `session.id`.
- **Sink.** Each push goes through `deps.onSessionState`, dispatched as `ingestSessionState` on the
  single-writer command loop — never applied inline in the file-change callback. A stray file for a deleted
  session is harmless (`ingestSessionState` no-ops for an unknown session).
- **Refresh affordance (R1, §5.4).** The manual "refresh state" path is `watcher.rescan(sessionId)` — a
  forced re-read + re-emit of one session's file — wired through `deps.refreshClaudeState`.

There is no `StateProvider`/`CompositeStateProvider`, no `ProgramStateDetectorRegistry`, no structural
sentinel, no OSC/`tcgetpgrp`/`/proc` polling, and no per-session socket — all removed. `Unknown` is the resting
state; transitions are event-driven (a file write) and emit immediately, so there is no debounce/hysteresis on
the state itself (only the watcher's write-coalescing debounce).

### 9.4 Phase 3 Jenkins state mapping

Poll `<job>/lastBuild/api/json` every ~10 s (configurable):
`building==true` → **Working**; `SUCCESS/UNSTABLE/FAILURE/ABORTED/NOT_BUILT` → **Waiting** (a failed pipeline
needs the user but isn't *asking* Octopus for anything → not Blocked); a pipeline **Input step**
(`PAUSED_PENDING_INPUT`, via `/wfapi/describe`) → **Blocked**. Never `Unknown` after the first successful
poll.

### 9.5 Ready-for-review (renderer view-model, not a domain state)

The product's core scan — *"ten agents running, which one just finished and wants my eyes?"* — is served
**without** adding a state to the lattice. A finished agent is `Waiting` (Idle) like any other idle shell; the
distinction "*just* finished, and I haven't looked" is **derived in the renderer from the state-change
stream** and lives only in the Zustand store:

- **Raise.** On a `sessionStateChanged` reducing to `Working → Waiting` (Working→Idle) for a session that is
  **not currently focused** (not the active tab of its window, or its window unfocused), set
  `readyForReview[sessionId] = true`. `Blocked → Waiting` does **not** raise it (the user was already being
  asked; resolving it isn't "new finished work"). A session that goes straight to `Waiting` without a prior
  `Working` (e.g. freshly spawned at a prompt) never raises it.
- **Clear.** On focusing that session (its tab becomes active in a focused window) → `readyForReview[sessionId]
  = false`. This is the primary clear path. As **defense-in-depth**, the flag is *also* cleared when the
  session leaves `Waiting` (a `Waiting → Working`/`Blocked` transition): once the agent is doing something
  again the "just finished, unseen" premise no longer holds.
- **Validity / supersession.** A raised flag is consumed **only while the session's current state is `Waiting`
  (Idle).** Any newer non-idle transition (`Working`/`Blocked`) supersedes it — the session displays that
  state, not `Review`. This is enforced at consumption in `sessionDisplayState` (which returns `Review` only
  for an idle+flagged session), so even a flag the store hasn't yet cleared cannot mask a running session.
  This fixes the bug where a session that finished-then-resumed (`Working → Waiting → Working`) showed the
  static review dot instead of the pulsing Working dot until it was focused.
- **Display level & task rollup.** The icon shown (session and task) is a `DisplayState` with priority
  `NeedsInput > Review > Working > Idle > None`. `sessionDisplayState(session, flag)` gives one session's
  level (with the idle gate above); `taskDisplayState(taskId)` is the **max** over the task's sessions —
  replacing the old `taskReadyForReview` OR-selector, which was independent of `TaskState` and so could show
  `Review` while a sibling (or the same session) was `Working`. `NeedsInput` still wins over `Review` (a
  blocked session demands action before a finished one wants a look). See §3.4.
- **Non-goals / bounds.** Not persisted (§5.4 — restart starts clean), not in any DTO, not aggregated by the
  domain, never in `sessionStateChanged`. It is pure UI memory keyed off events the store already receives, so
  it needs **no** backend, port, or protocol change — only store reducer logic + the icon variant (§5.4). The
  focus signal it needs (which session is active in which window) is already in the store (§5.2, §5.6).

### 9.6 Where detection runs: out-of-band, backend-agnostic

State detection **does not read the PTY at all** and is **not a runtime concern** — neither backend
participates. The Claude python bridge (§9.1) runs as Claude's own hook/statusline subprocesses, entirely
outside Octopus's process tree, and writes each session's state file; the single app-side `ClaudeStateWatcher`
(§9.3, in Electron main) reads those files and feeds `ingestSessionState` on the command loop. This is
identical whether the PTY lives in `octopusd` or in-process, so `SessionRuntime` carries **no state seam** and
the daemon protocol carries **no state message** — both were removed when this replaced the earlier
socket/composite design.

- **Why the fd's owner no longer matters.** The old design had to host detection wherever the PTY master fd
  lived (in-process → Electron main; daemon → inside `octopusd`) because it needed `tcgetpgrp(master_fd)` and
  the OSC byte stream. The bridge needs neither: it is driven by Claude's lifecycle hooks and statusline, whose
  subprocesses inherit `OCTOPUS_SESSION_ID` from the PTY environment (§9.1) regardless of which process spawned
  the PTY. The only requirement on the runtime is that it injects `OCTOPUS_SESSION_ID` into every managed PTY —
  which both `PtyTerminalRuntime` and the daemon's `pty-registry.ts` do.
- **Consequence for the protocol (§6.2).** State detection removed the `state` `CONTROL` frame and the
  `refreshState` command entirely — the manual "refresh state" affordance (R1, §5.4) is served app-side by
  `ClaudeStateWatcher.rescan(sessionId)` (a forced re-read of the local file), needing no round-trip to the
  daemon. The `DATA` path is untouched (as before), so the <5 ms terminal budget (§11) is unaffected.
- **Protocol-version coupling (the durable-daemon upgrade trap).** Because `octopusd` is detached it outlives
  not just an app restart but a **rebuild**, and the app reconnects to whatever daemon holds the socket.
  REMOVING the `state`/`refreshState` messages therefore **bumps `PROTOCOL_VERSION` (2 → 3)** for the same
  reason adding them did (1 → 2): a stale v2 daemon would keep emitting now-unknown `state` frames. The `hello`
  handshake carries the daemon's `pid`, so on a version mismatch the app **retires the stale daemon** (SIGTERM
  by pid, waits for it to release the socket) and launches a fresh one; a compatible daemon is left untouched.
  Any future daemon protocol change must bump `PROTOCOL_VERSION` for the same reason.
- **Fallback.** If the daemon launch fails and the app degrades to in-process for that run (§6.2), detection is
  completely unaffected — the bridge + watcher are backend-agnostic by construction.

### 9.7 Known limitations (heuristic edges, verified)

State detection is a best-effort heuristic layered on signals Claude Code was never designed to export as a
state machine. It classifies the common path (prompt → work → tools → finish, plus mid-turn permission prompts)
correctly the large majority of the time, but the following edges are known and **cannot** be eliminated
without a richer signal (e.g. an Octopus MCP server, deferred in §9.2). They are ordered by user impact.

- **Mid-tool `tool_use` can transiently read as `Blocked`.** `derive_transcript_state` maps a dangling
  `tool_use` (a `tool_use` with no matching `tool_result`) → `blocked`, unless every dangling one is a
  delegation tool (§9.2). A non-delegation tool that is merely *mid-execution*
  has the identical transcript signature to a tool awaiting a permission prompt. Because `transcript.mtime`
  advances when the assistant streams a fresh `tool_use` block — potentially *before* the next `PreToolUse`
  hook fires — a `statusline` tick in that window wins the newer-observation race and flips a `working` session
  to `NeedsInput`. **Self-correcting** (the next in-turn hook overwrites it), so it is a transient flicker, not
  a stuck state. Mitigation shipped: transcript-derived `blocked` is only honored when it is not contradicted by
  a recent in-turn `working` hook (see §9.1) — this collapses the window to the rare case where no hook fires at
  all.
- **Interrupt (Esc) mid-tool → sticky `NeedsInput` until the next prompt.** An interrupt leaves a dangling
  `tool_use` in the transcript with no clean-up hook, so at rest the transcript inference reads `blocked`. There
  is no event that clears it; it resolves on the next `UserPromptSubmit`. Untested by construction (no hook
  models an interrupt).
- **Hooks installed mid-turn → `Unknown` for the current turn.** Turn gating requires a `UserPromptSubmit` to
  open the turn; a session already running when Octopus first injects the hooks (or on first-run before the
  user has submitted a prompt under the new settings) has a *closed* turn, so in-turn `PreToolUse`/`PostToolUse`
  observations are gated out and **no state file is created** — the session stays `Unknown` until the next
  prompt. The transcript backstop only helps if a `statusline` fires and the transcript is not frozen at a
  dangling state.
- **Subagent delegation (background & foreground) is actively handled; residual edges remain.** A session that
  delegates to subagents (`Task`/`Agent`) is held `Working` for the whole run by the `subagents` counter
  (`PreToolUse(Task|Agent)`++ .. `SubagentStop`--, with `Stop` deferring turn-close while the count is `> 0`) and
  by delegation-aware transcript inference on the resume/no-hook path — see §9.1/§9.2. Edges persist, ordered by
  impact.
  (1) **A truly *absent* `SubagentStop` latches the session Working with no automatic release.** The
  `subagent_count > 0` override short-circuits `effective()` *before* the transcript backstop, so a leaked entry
  (a `SubagentStop` that never fires at all — child crash/kill, or an interrupt (Esc) mid-subagent that surfaces
  as a deferred `StopFailure`) holds Working until the next `UserPromptSubmit` clears both tracking paths.
  Because the false state is *Working* (not the milder NeedsInput), it also suppresses the §9.5 ready-for-review
  highlight, so the very tab that needs attention looks busy. Recovery is the next prompt only; there is no
  timeout. **This is the accepted residual cost of never reading a delegating session as prematurely-done.**
  Note the related *duplicate/stray* `SubagentStop` under-count — a spurious stop wrongly cancelling a *live*
  child — is **closed** on the primary path: `subagent_ids` removal by `agent_id` is a no-op for an id that is
  not in the set, so only the matching child is ever cleared (the anonymous fallback counter, used only on
  versions with no `SubagentStart`, remains vulnerable to it).
  (2) **Fire-and-forget converges without a resume (fixed):** when the main agent `Stop`s while a background
  child runs, the Stop is deferred with a `stop_deferred` flag; the last child's `SubagentStop` (counter → 0
  with the flag set) finalizes the close to Idle even if the main agent never resumes (§9.1). The residual
  exposure is the reverse: if the main agent *does* resume right after that finalize (to consume the child's
  result), Idle shows for the gap before the fresh `UserPromptSubmit` — a sub-second blip the §9.3 watcher's
  ~40 ms coalescing usually swallows. Accepted as strictly better than the pre-fix unbounded stuck-Working.
  (3) **A main-agent `blocked` can be masked by a concurrent background child's routine hooks.** The single
  `hook` slot cannot represent "main awaiting permission AND child working" at once: while `subagents > 0`, a
  genuine `PermissionRequest`/`Notification` (→ NeedsInput, correctly) is overwritten back to `working` by the
  still-running child's next in-turn `PreToolUse`/`PostToolUse`, hiding the prompt behind Working until the main
  agent re-emits it or the child ends. A permission prompt raised while no child is outstanding is unaffected.
  (4) **Nested subagents** (a subagent spawning its own subagent) are tracked only if their hooks carry the same
  `OCTOPUS_SESSION_ID`; a mismatch would under/over-count, but on the primary path a mismatched `agent_id` is a
  distinct set entry (no collision), and the `UserPromptSubmit` reset still bounds any drift to one turn.
  (5) **Sidechain layout is version-coupled but guarded:** today's Claude writes subagent activity to *separate*
  `subagents/agent-*.jsonl` files and the `statusline` `transcript_path` names only the main transcript, so a
  subagent's own dangling `tool_use` never appears there; `derive_transcript_state` additionally skips
  `isSidechain` records, so even a future version that inlines sidechains into the main transcript stays correct.
- **Lost-update race between the hook and statusline processes.** The hook and statusline run as independent OS
  processes doing read-modify-write on the same `<id>.json`; `os.replace` makes each *swap* atomic but not the
  read-modify-write *pair*, so a sufficiently tight interleave can drop one observation (e.g. a hook write
  clobbered by a statusline that read the pre-hook file). Low-probability and self-healing (the next write of
  either kind re-converges), accepted as a documented risk rather than serialized with a lock.
- **Silent degradation to `Unknown`.** Every hook is `… 2>/dev/null || true` and the bridge swallows all write
  errors (§9.2), so any of: `python3` absent from PATH, `OCTOPUS_SESSION_ID` not surviving into the hook
  subprocess env, or a Claude version renaming an event / changing the `transcript_path`/`stop_reason` payload
  shape — degrades the affected session to `Unknown` with no error surfaced. This is the intended
  graceful-degradation posture, and it is why detection is not, and cannot be advertised as, correct 100% of the
  time.

---

## 10. Phases Roadmap

**Principle:** define interfaces/enums in phase 1; add *implementations* in phase 2/phase 3. Signatures never change across
phases.

### Phase 1 — Tasks, Sessions, Progress window, Terminal (no state)

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
- **Seams to leave (explicit):** `capabilities.EvaluatesState` (Terminal off); `EventBus` carries state events
  (dormant); aggregator called but yields `Unknown`; view resolution already keyed by `typeId`; `SessionConfig`
  already validated against `configSchema`; `OCTOPUS_SESSION_ID` injected into every PTY (the key phase 2's
  out-of-band Claude bridge later correlates on, §9.1); `CredentialsProvider` port shape defined. *(The earlier
  plan also reserved a `stateEvaluator()` runtime seam + an `OCTOPUS_STATE_SOCKET` per-session socket; phase 2
  replaced that with the out-of-band bridge (§9.6), so neither exists.)*

### Phase 1.5 — Multiple windows

Ships on top of feature-complete phase 1; **strictly additive** — no domain/port/IPC signature changes, only new
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

**Forward-compatibility.** Phase 2 is unaffected: status icons (§9) render per-session in whatever window hosts
the session; `sessionStateChanged/taskStateChanged` are broadcast to all windows. The phase 2 durable-session
daemon (§6.2) stays compatible — it echoes `windowId` on each event to route to the right window. Phase 3 (Jenkins)
is untouched: a `JenkinsPane` carries a `windowId` like any session and moves between windows the same way.

### Phase 2 — Session state + aggregation + icons

- Implement the **out-of-band Claude state bridge** (§9.1): one stdlib-only python3 script, embedded in TS and
  written to the data dir on startup, wired into Claude's lifecycle hooks + statusline via a merge-safe edit of
  `~/.claude/settings.json` (§9.2, §12.1). It writes a per-session state file keyed by `OCTOPUS_SESSION_ID`
  (turn-gated newer-observation-wins over the hooks + transcript). Flip Terminal's `EvaluatesState` on.
- **Detection is backend-agnostic and not a runtime concern (§9.6):** the bridge runs as Claude's own
  subprocesses, and a single app-side `ClaudeStateWatcher` (Electron main) file-watches the state dir and feeds
  `ingestSessionState`. Same for the in-process and daemon backends — no state seam on `SessionRuntime`, no
  state message on the daemon protocol (the earlier `state`/`refreshState` frames were REMOVED, bumping
  `PROTOCOL_VERSION` to 3).
- Wire the existing `sessionStateChanged` → ingest (single-writer loop) → `TaskStateAggregator` → view-model
  → icons in the progress window and on tabs. No debounce on the state itself (§9.3 — transitions are
  immediate). **Shared vocabulary Unknown/Idle/Working/NeedsInput** (§3.3); **ready-for-review** highlight as a
  renderer view-model flag (§9.5 — store-only, no backend). Add the state transition log + debug overlay.
- **No new ports, no domain signature changes.** New pieces are all additive at the composition root: the
  startup `ensureClaudeHooks`/`ensureClaudeStateScript` wiring and the `ClaudeStateWatcher` adapter (+ its
  `rescan` serving the manual "refresh state" affordance app-side), and renderer store/selectors. Optionally
  expose the alternate aggregation precedence as a setting. *(Durable-session infra — **done ahead of phase
  2**:* `SessionManager` has a durable `octopusd` daemon backend, the default `terminal.backend` (opt out with
  `'in-process'`), that survives an app restart and re-attaches live PTYs — cwd + foreground program +
  scrollback intact (§6.2). Renderer unaffected, exactly as the port boundary reserved. Because detection is
  now out-of-band, it is unaffected by which backend owns the PTY.)*

### Phase 3 — Jenkins Pipeline Viewer

- Add `JenkinsClient` port + `JenkinsHttpClient` adapter (auth via `CredentialsProvider`/keychain — never
  plaintext). Add `JenkinsSessionTypeProvider` (`EvaluatesState` on, config schema job/branch/creds) +
  `JenkinsViewFactory` + `JenkinsProvider` state mapping (§9.4). Register at the composition root; dropdown
  and aggregation pick it up automatically. **Zero changes** to Domain, Application use cases, Terminal, or
  the aggregator.

---

## 11. Cross-Cutting Concerns & Risks

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | State-detection reliability | High | Status is Claude-only, sourced out-of-band from Claude's own hooks + statusline (§9.1, §9.2) — no PTY parsing, no heuristic. Turn-gating stops a stray post-`Stop` sub-event resurrecting Working; the transcript backstop covers a resumed/legacy mid-turn file; `ClaudeStateWatcher.rescan` is the manual "refresh state" affordance; log every transition. |
| R2 | PTY performance with many sessions | Med | Single epoll loop; output batching (leading-edge + 3 ms trailing coalesce, §6.6); state detection is off the PTY path entirely (§9.6 — external python bridge + file watches), so it adds nothing to the hot path. |
| R3 | Worktree provisioning safety (repo-local script **or** native git) | High | Validate the resulting path (absolute, exists, is a directory; warn if not a git worktree); containment check before delete (exactly the stored path, not `/`/`repoDir`/an ancestor); 30 s timeout; show command output; **all inputs passed as argv — no shell interpolation** for both scripts and native git (I17). |
| R4 | Keeping many sessions alive / crash loses agent work | Med | Phase 1 accepts loss + fresh-shell restore; durable backend (tmux/daemon) is the phase 2+ mitigation behind `SessionManager`; warn on quit if Working/Blocked. |
| R5 | Security (air-gapped on-prem): state-file trust, secrets | Med | The bridge only reads/writes JSON — nothing from Claude's payloads is ever executed; the watcher reads a small set of known fields and maps unknown states to `Unknown`; `~/.claude/settings.json` edits are merge-safe and tagged (`#octopus-state`), never clobbering the user's config; secrets only via keychain (`credentialsRef`), never in the store/JSON. |
| R6 | Bridge failure degrades gracefully | Low–Med | Every hook is `… 2>/dev/null \|\| true` and the bridge wraps every write; a failure is a silent no-op (session stays `Unknown`) and the user's statusline still renders (the bridge chains to their saved original). |
| R7 | State flicker | Low | Claude-only, event-driven from discrete hook/transcript observations (§9.1): no activity/staleness timers to flap between. Newer-observation-wins is self-dating; turn-gating prevents a stale sub-event from flipping a finished session. |
| R8 | (phase 1.5) Cross-window move race — window moved between drop and `windowAtPoint`, or overlapping unmount/mount | Low | Hit-test is best-effort; worst case the session lands in the wrong window and is re-draggable. Source/target renderers are separate processes, so a brief double-sink during the move overlap cannot collide; the `pty-router` pending buffer covers the pre-mount gap (§6.7). |
| R9 | (phase 1.5) Quit blocked by the secondary-window close dialog | Low | `before-quit` sets an `isQuitting` flag; the secondary `close` handler skips its dialog when quitting, so `Ctrl+Q` runs the normal graceful shutdown (§6.7). |
| R10 | (phase 1.5) Persisted window off-screen after a monitor change | Low | On restore, clamp any window intersecting no display work area to the nearest display (`screen.getAllDisplays()`), preserving size (§6.3). |

**Observability:** structured JSON state-transition log at `~/.local/share/octopus/state.log`;
keyboard-toggled debug overlay showing the last N transitions per session (reason + observation source).

**Testing strategy:** unit (the REAL python3 bridge shelled out — event→state mapping, turn-gating,
newer-observation-wins, transcript inference; aggregation combinations — all skip-if-no-python3); integration
(end-to-end: real bridge writes a state file → real `ClaudeStateWatcher` → `coreToSessionState` → sink,
including the stray-post-`Stop` regression and resume-recovery initial scan); e2e (real Claude Code with the
injected hooks → assert Working/Blocked/Idle). Worktree scripts tested against a throwaway repo with a fake
create/delete script.

**Performance targets:** PTY read→render <5 ms; hook→state-file-write <20 ms; file-change→task icon
<100 ms (fs.watch + ~40 ms coalescing debounce, §9.3); Jenkins poll 10 s; per-session state file < a few KB.

---

## 12. Resolved Decisions

These were reviewed and decided; recorded here so implementation doesn't re-litigate them.

1. **Auto-inject Claude Code hooks + statusline — YES, opt-out.** On startup Octopus writes the python state
   bridge into the data dir and **merges** hook entries + a statusline into the user-global
   `~/.claude/settings.json`, **never clobbering an existing file** — its own entries are tagged
   (`#octopus-state`) so they can be found and updated idempotently, and the user's original statusline command
   is saved so the bridge chains to it (§9.1, §9.2). Editing on startup (not per-worktree) means a developer
   who doesn't even have this repo gets configured, so phase 2 state icons work out of the box instead of
   requiring hand-configuration. Gated by the `terminal.injectClaudeHooks` setting (default on). Correlation is
   by `OCTOPUS_SESSION_ID`, injected into every managed PTY, so one global settings entry serves every session.
2. **Durable backend (survive app restart) — deferred to phase 2, behind `SessionManager`.** Phase 1 hosts PTYs
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
5. **Multiple windows (phase 1.5) — main + secondary, synced on one active task.** The main window owns the
   progress panel; secondary windows are session-only. All windows share the single `activeTaskId`, so
   switching a task switches sessions in every window. Session→window is an opaque `windowId` on `Session`
   (default `MAIN_WINDOW_ID`); window bounds live only in persistence. Cross-window DnD is *detach +
   drop-on-window* (§5.6). Closing a secondary window with live sessions asks (move-to-main vs kill); closing
   the main window quits the app. Windows + assignments restore on relaunch, with off-screen clamping (§3.7,
   §5.6, §6.7, I18).
