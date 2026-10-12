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
| How status is detected | **Claude-only, out-of-band via a hook recorder + app-side fold.** A single stdlib-only python3 script wired into Claude's hooks appends each hook to the session's events log (keyed by `OCTOPUS_SESSION_ID`); a pure app-side fold turns the log (plus transcript facts) into a state. Octopus never reads the PTY or process table. Non-Claude foreground programs stay `Unknown` (no heuristic). | §9.1, §9.2 |
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
│     ClaudeStateWatcher (phase 2) → folds the hook recorder's events logs          │
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
just broadcast to all windows (§6.7). A window may render **zero** sessions (empty state). Roles: the **main**
window shows the progress panel and sessions; **secondary** windows are session-only.

**Per-window marks.** Each window keeps its **own** marked (displayed) tab per task — `activeSessionByTask` in
that window's store holds a session the window hosts, or nothing (`activeSessionInWindow` resolves a missing
mark to the window's first tab). It is renderer-only view state: no DB column, no DTO field. The **focused
session** is the marked tab of the OS-focused window for the active task; it is what the session shortcuts
anchor on (§5.4), and it is what persists as `task.activeSessionId` (I10). So with two windows, each shows its
marked session, and moving between them never blanks or re-points the window just left.
- **Cross-window switch** (keyboard walk into another window's tab): `switchSession` broadcasts
  `activeSessionChanged{windowId}`; **only the host** moves its mark, and main raises the host (§6.7). The
  window left keeps its mark.
- **Focus gain** (mouse click into the window, Alt+Tab, the raise above): the window persists its mark as the
  focused session via the persist-only `focusSession` command (pointer write, no event, no raise — so a focus
  event racing ahead of `activeSessionChanged` can't flip the host back). It also flashes the marked tab (§5.4).
- **Restore** (no DB change): the window hosting the persisted `task.activeSessionId` marks it; every other
  window marks its first hosted tab. A re-hydrate keeps a mark that is still hosted.
- **Move** (drag / "Move to"): the target window marks the moved session. If it was the source's mark, the
  source falls back to the right neighbour, else the left. The bulk "move to main" on a window close
  (`sessionMovedToWindow{cause:'windowClosed'}`) keeps main's mark; main marks a moved session only if it
  hosted none of that task's sessions.
- **Close** of a window's marked tab: the window falls back to its **last** remaining tab.

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

Zustand store holds: `tasks`, `sessions`, `activeTaskId`, THIS window's marked session per task
(`activeSessionByTask`, §3.7), and (phase 2) each
session's `state` (already a field on `SessionDTO`/`TaskEntry` — the phase-1 seam, always `'unknown'` in
phase 1) plus a `hasUnseenFinishedTurn` map and the `sessionDisplayState`/`taskDisplayState` selectors that
fold it (with a display-time on-screen check) into the §3.4 display-state priority (§9.5). **High-frequency `ptyData` bypasses the store** — it is delivered by IPC directly to the
target `TerminalPane`'s `terminal.write(data)`. On startup the renderer calls `app:getState` (§6.5) to
hydrate; thereafter lifecycle/status events patch the store. The store already has `reduceEvent` cases for the
dormant `sessionStateChanged`/`taskStateChanged` events (patching `sessions[id].state` / `tasks[id].state`) —
phase 2 only makes them fire and adds the `hasUnseenFinishedTurn` bookkeeping off the same `sessionStateChanged`.

`ptyData` that arrives for a session whose pane hasn't mounted yet is held in `pty-router.ts`'s per-session
pre-mount buffer and replayed on `registerTerminalSink`. That buffer is **bounded independently of** the
backend ring (500 KB here vs the daemon's 5 MB/session, §6.2): it only has to cover the milliseconds before a
pane mounts, and it is paid once per un-mounted session inside one renderer process. Both eviction paths
matter — oldest-chunk-first, **and** tail-truncation of a *single* oversized chunk, because a daemon re-attach
replays a whole 5 MB ring as one `ptyData` frame, which chunk eviction cannot bound.

```
Keystroke:  xterm onData → octopusAPI.pty.input → ipcMain → pty.write
Output:     pty onData → (batched, §6.5) → webContents.send('pty:data') → terminal.write   [not via store]
New task:   modal → octopusAPI.tasks.create → provision worktree (script or native git) → persist → resolve → store.createTask
Status(phase 2): evaluator (main, or octopusd→CONTROL) → ingest → sessionStateChanged → store patches
                 session.state (+ taskStateChanged) → TaskStatusIcon/SessionStatusIcon re-render;
                 Working→Idle → store.hasUnseenFinishedTurn[id]=true → green check (shown at display time
                 while the session is idle + off-screen)
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
- **Keep-alive × cheap-looking writes = a renderer-process kill.** Keep-alive multiplies every per-terminal
  cost by the session count, so anything a TUI does *per frame* must be O(cheap) in **all** panes. xterm
  option writes are not: `DomRenderer` (and the WebGL/Canvas renderers) subscribe to `onOptionChange`
  **unfiltered**, and the handler rebuilds + reparses that terminal's entire theme stylesheet (~55 KB) and
  forces two layouts. DECSET/DECRST **12** (cursor blink) *is* an option write in xterm, and Emacs' repaint
  (`cnorm` then `cvvis`) emits two per frame — measured at 199 option events per 100 repaints. With 47
  sessions restored (each replaying its daemon ring buffer at once) the main window's renderer RSS went
  96 MB → 1.9 GB in ~12 s and Chromium aborted the process (`render-process-gone`, `reason: 'crashed'`,
  `exitCode: 133` = SIGTRAP) — **no** JS error, V8 heap at 240/4096 MB, i.e. all of it Blink-side CSSOM /
  layout churn, leaving a permanently white window. Mitigation: `cursor-blink-guard.ts` registers a parser
  handler that swallows DECSET/DECRST 12 when mode 12 is the **sole** parameter (combined forms still fall
  through so their other modes apply), which breaks the alternation and lets `OptionsService` dedupe the rest:
  199 events → 1. General rule for this layer: **route around xterm option writes on hot paths; never add one
  per frame.** The safety net for the class is §6.7's `render-process-gone` handler.

Rejected: unmount + backend-buffered replay (perceptible 50–300 ms "pop" on switch, cursor/selection
restore complexity). The serialize-and-replay path is kept available for a future durable-backend re-attach
(§6.2), not for routine task switching.

### 5.4 UX details

- **Tabs:** horizontal scroll on overflow with chevrons; overflow "…" menu beyond ~8 tabs; drag-reorder via
  `@dnd-kit/core`; per-tab `×` close (fires `pty:destroy`).
- **Focus flash:** when a window gains OS focus (keyboard cross-window switch, a mouse click anywhere in it,
  Alt+Tab), its marked tab of the active task (§3.7) plays a 1 s accent-fill fade (`--accent-flash` → the
  normal active-tab background) to show which session is now focused. It is a store flag (`focusFlashOn`,
  ended by a `FOCUS_FLASH_MS` timer in `App`), not a status indicator. It does not play on a same-window
  switch, on a window's first appearance, or under `prefers-reduced-motion`.
- **New Task:** modal with three tabs and an info button (top-right) whose hover/focus tooltip explains the
  active tab's delete behavior. **From New Worktree** (default): four fields — **name**, **repo directory**
  (a native OS directory picker via a `dialog:pickDirectory` IPC), **source branch**, **new branch**
  (prefilled with a slug from the name, editable); Octopus provisions a fresh worktree (`managed: true`).
  **From Existing Repo**: **name** + an existing **repository directory** Octopus adopts as-is (git detects
  its owning repo + branch; the repo's main checkout is allowed), stored `managed: false`. **No Repo**:
  **name** only — a repo-less task (`repoLess: true`, no worktree) for ad-hoc/scratch work (checking mounts,
  `less` on a log, editing a config file); it is created **synchronously** (no script, no git, nothing on
  disk) and becomes `Ready` at once, and its sessions open at the **home directory** with no `cd` (§6.1,
  §6.2). "Create Task" → for the two repo tabs, a spinner while the worktree is provisioned/adopted
  (repo-local script or native git, §6.4) → on success new task becomes active with empty state; on failure
  show stderr in a red block + Retry + toast. In the progress panel's grouped view, repo-less tasks form
  their own **"No Repository"** group (ordered after all repo groups).
- **New Session:** dropdown populated from the session-type registry (filtered by `availableFromVersion ≤
  currentVersion`). Terminal creates immediately; Jenkins (phase 3) opens a small config modal.
- **Delete Task:** confirm dialog whose body reflects ownership (§6.4) — a managed worktree "closes all
  sessions and removes the worktree", an adopted repo (`managed: false`) "closes all sessions" but leaves
  the directory on disk, and a **No Repo** task "closes all sessions" with nothing removed from disk (no
  worktree exists); on dirty worktree, an extra "uncommitted changes — delete anyway?" confirmation
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
  inferred). Next/prev session and close session act on THIS window's mark (§3.7); next/prev walk the
  active task's tabs across windows, raising the host window when the walk leaves this one. A capture accepts any key but is validated to require ≥1 modifier (so it can't shadow a bare
  terminal keystroke) and is checked for conflicts against every other configurable chord (and
  `RESERVED_CHORDS`, currently empty) before Save is allowed. `Ctrl+Shift+C/V` copy/paste and `Esc` close
  modal/dropdown are not configurable. Because every binding requires a modifier, terminal `Ctrl+C` etc. are
  never stolen. `TerminalPane` also installs an xterm `attachCustomKeyEventHandler` that drops both every
  `Ctrl+Shift` chord AND the eight configurable chords before they become PTY input, so a global shortcut is
  never *also* written to the terminal (the `window` listener's `preventDefault` alone is unreliable —
  xterm's textarea handler runs first).
- **Empty states & toasts:** "No tasks yet", "No sessions", inline "Connecting…" written into the terminal;
  top-right toasts for script failures, unexpected PTY exit, the §9.5.1 status-change cue, Jenkins errors
  (phase 3).

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
`SecondaryWorkspace` filters the session set to `session.windowId === thisWindowId`, and each window shows
its own marked tab per task (§3.7) — `TaskView`/`SessionTabBar` resolve it via `activeSessionInWindow`, never
a pointer shared between windows. The WebGL context
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
         OCTOPUS_TASK_ID, OCTOPUS_SESSION_ID /* keys the Claude events log, §9.1 */,
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
  renameTask, reorderTask, createSession, closeSession, switchSession, focusSession (persist-only, §3.7),
  renameSession, reorderSession,
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
- **`ptyData` and session-scoped events** (`sessionExited/Closed/Reordered`) → **only the
  window hosting that session** (look up `session.windowId`; drop silently if the session is mid-close).
  `sessionCreated` is **broadcast**: every renderer replicates the full session set, and the cross-window
  session walk (§5.4) and the main window's rollup need sessions created in other windows.
- **`sessionMovedToWindow`** (new) → **both** the source and target windows, so both re-render in one cycle.
- **Task-level / broadcast events** (`taskCreated/Deleted/Renamed/Reordered/Stale`, `sessionRenamed`,
  `activeTaskChanged`, `activeSessionChanged`, `scriptProgress/Error`, `error`, settings, and the dormant phase 2
  `sessionStateChanged/taskStateChanged`) → **all** windows — every window keeps its active-task view (and the
  main window its full task list) correct. `sessionRenamed` broadcasts (not host-scoped) because every renderer
  replicates the full session set including `title`; host-only routing left non-host windows showing the stale
  pre-rename name once the session was moved into them (the move event patches only `windowId`).

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
  toWindowId, cause?}` (`cause: 'windowClosed'` marks the bulk move-to-main, so main keeps its mark, §3.7).

**Cross-window switch raise.** On `activeSessionChanged` the composition root raises the host `BrowserWindow`
and calls `webContents.invalidate()`, so the VDI's software compositor repaints the host's moved mark and
focus flash without waiting for input (§9.7).

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

**Renderer-crash visibility + recovery.** A renderer process that Chromium aborts is otherwise **completely
silent**: Electron does not respawn it, `webContents.isDestroyed()` stays **false** afterwards, so the registry
keeps `send`ing into a dead process and the user just sees a white window (that is exactly how the §5.3 option-
write OOM presented). So every window wires `render-process-gone` (`wireCrashRecovery` + the pure
`decideCrashRecovery`): log `reason`/`exitCode` with the window identity, **re-`register`** the window (which
resets its entry to `{ready:false, pending:[]}` so nothing is sent to or queued for the dead renderer until the
reload's `getState` re-arms it), then `webContents.reload()` — bounded at 2 auto-reloads per 60 s burst, after
which a `['Reload','Quit']` dialog hands the decision to the user. Never `window.destroy()`: on a GPU-less VDI
that tears the display surface out from under Chromium and exits the whole browser process. `unresponsive` /
`responsive` / main-frame `did-fail-load` are logged too. A reload restores from `getState`; terminals reconnect
but start with empty scrollback (the daemon already replayed its ring on the original attach) — strictly better
than a white window, and re-attach-on-reload is the eventual fix (§6.2).

Two related bounds, because this queue lives in the **main** process where a leak takes the whole app down: a
destroyed `webContents` **drops** rather than buffers (it can never come back, and `markReady` discards the
queue anyway), and the pre-hydration `pending[]` is capped (`PENDING_MAX_EVENTS`, oldest dropped first, warned
once) — `ptyData` in the register→`getState` gap is unbounded in principle.

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
  **I10.** `activeSessionId` (if set) references a session in that task. It records the last **focused**
  session — the OS-focused window's mark (§3.7) — written by `switchSession` or the persist-only `focusSession`.
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
Claude hook recorder appends to each session's events log and the app-side `ClaudeStateWatcher` emits
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
or any other foreground command, is `Unknown` (no icon). State is sourced **out-of-band**: Claude itself runs a
tiny python3 **recorder** from its hooks, which appends each hook to a per-session events log; Octopus folds that
log (plus a few facts tailed from Claude's own transcript) into a state, app-side. Octopus never reads the PTY,
the process table, or a socket to compute state. The runtime/daemon do not participate at all (§9.6).

The design follows Orca's approach: **the hook only records, the app decides**. The earlier design put the state
machine inside the python bridge (a read-modify-write state file guarded by a `flock`), which could not see the
whole picture at once — two background agents, a stale `SubagentStop`, a wake-up prompt — and kept producing
"done while still working" and "done-then-working" bugs. A pure, replayable fold over an append-only log is
testable against recorded live traces (`test/fixtures/claude-state/`) and can reason across events.

### 9.1 The hook recorder (one script, record-only)

A single stdlib-only python3 script — `octopus-claude-state.py`, embedded as a string in
`src/adapters/claude/octopus-claude-state.script.ts` and written into the data dir on startup by
`ensureClaudeStateScript` (the same embed-and-write-on-boot pattern as the shell-integration rc files, chosen
over a bundled asset because electron-vite's `out/` vs `release/` layouts make an on-disk asset path fragile).
It holds **no state logic** and has two modes, both driven from `~/.claude/settings.json`:

- **`hook <Event>`** — wired to Claude's lifecycle hooks (§9.2). Appends ONE compact JSON line to
  `<dataDir>/claude-state/<OCTOPUS_SESSION_ID>.events.jsonl`.
- **`statusline`** — wired to `statusLine.command`. A pure pass-through: runs the user's ORIGINAL statusline
  command with the same stdin and prints its output verbatim (so the user's status bar is unchanged). It
  records nothing.

Any other mode is a silent no-op. The hook never prints and always exits 0 (wrapped in a catch-all), so it can
never disturb Claude.

**The record.** Common fields `v` (format), `t` (epoch ms at hook time), `ev`, `sid` (Claude `session_id`),
`aid` (`agent_id`; absent ⇒ the lead agent), `prm` (`prompt_id`). Per event, only what the fold needs:
`src` (SessionStart source), `tp` (transcript path), `rsn` (SessionEnd reason), `tn` (the task id of a
harness `<task-notification>` prompt — the prompt text itself is **never** stored), `tool` / `tu`
(`tool_use_id`) / `ih` (a short hash of the canonical `tool_input`, which correlates a `PermissionRequest` —
which carries no `tool_use_id` — with its `PreToolUse`), `bga` / `fga` (the agent id of a background launch /
a finished foreground run, from `PostToolUse(Agent|Task)`'s `tool_response`), `intr` (`is_interrupt`), `at`
(agent type), and `bg` (the `background_tasks` inventory, `{id, ty, st}` only, capped). Strings are capped; a
line over 8 KiB drops `bg`/`tp`.

**Appending.** `O_WRONLY|O_APPEND|O_CREAT|O_CLOEXEC`, mode `0600`, one `write(2)` per line — whole lines do not
interleave between the concurrent hook processes of one session (covered by a 30-parallel-process test), so no
lock is needed. Keyed by `OCTOPUS_SESSION_ID` (the env var Octopus injects into every managed PTY, inherited by
the hook subprocesses — so one global settings entry serves every session and every worktree, and the script is
a silent no-op outside an Octopus PTY). The id must match `^[A-Za-z0-9_-]{1,128}$` (it is a file stem).

**Nested Claude filter.** A `claude -p` started from *inside* a session's Claude (by a tool, a script, or the
user) inherits the same `OCTOPUS_SESSION_ID`, and its hooks would otherwise pollute the session's log. The
recorder walks its process ancestry (`/proc/<pid>/stat`); if it finds a second `claude` ancestor whose
environment also carries this `OCTOPUS_SESSION_ID`, the hook belongs to a nested Claude and is dropped.

### 9.2 Claude Code hook / statusline wiring (the only reliable `Blocked`)

"Blocked waiting for permission" is internal to Claude Code — no OS primitive exposes it (it is foreground,
has printed a prompt, and is reading stdin — indistinguishable from Waiting from outside). Solution: let Claude
tell us, via its own hooks.

- Octopus merges into the user-global `~/.claude/settings.json` on startup (merge-safe + idempotent, tagged
  with `#octopus-state` so only Octopus's own entries are ever touched — see
  `src/adapters/claude/claude-hooks.ts`):
  - each event in `HOOK_EVENTS` runs `python3 <script> hook <Event>`: `SessionStart`, `SessionEnd`,
    `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`,
    `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`;
  - an Octopus entry left on an event no longer in that list (e.g. `Notification` from an older build) is
    removed, keeping the user's own entries there; `hasAllOctopusHooks` treats such a leftover as "needs a
    rewrite";
  - `statusLine.command` is repointed at `python3 <script> statusline`, after SAVING the user's original
    command (to `claude-state/original-statusline`) so the recorder can chain to it.
- **`Notification` is deliberately not wired.** It fires both for a real permission prompt (seconds after the
  `PermissionRequest` that already said so) and for the idle "waiting for your input" reminder after a finished
  turn — it adds only noise.
- **Graceful degradation.** Every hook is `python3 <script> … 2>/dev/null || true`, so a failure is a silent
  no-op and the session stays `Unknown`. Nothing from Claude's payloads is ever executed; the recorder only
  parses JSON and appends.

Alternatives (inferior): parsing Claude Code's terminal output (brittle, version-coupled) or an Octopus MCP
server (richer but heavier — defer).

### 9.3 App-side consumer: the watcher and the fold

**The fold** (`src/adapters/claude/claude-session-fold.ts`) is a pure reducer: `applyHook` / `applyTranscript`
fold observations into a `ClaudeFold`, and `resolveFold(fold, now)` yields one `SessionState` plus a `reason`
string (`<why> <- <last event>`, logged with each transition, §11). Per Octopus session it tracks:

- **The lead agent's phase** (`none` / `working` / `done` / `ended`; events with no `agent_id` are the lead's).
  `UserPromptSubmit` and lead tool events → `working`; `Stop` / `StopFailure` / a transcript turn end /
  `PostToolUseFailure` with `is_interrupt` → `done`; `SessionStart` (not `compact`) → `done` (at rest);
  `SessionEnd` → `ended` (no icon), except reason `clear`, which a `SessionStart(clear)` follows.
- **The revive gate.** Once the lead is `done`, a lead event revives it only if it carries the SAME `prompt_id`
  (a user `Stop` hook continuation); a stray late event of an older prompt changes nothing. Only a new prompt
  starts a new turn.
- **A roster of running subagents.** `SubagentStart` adds; `SubagentStop` removes. A child-attributed event for
  an id the roster does not hold **never** creates an entry — Claude runs internal side agents that emit tool
  hooks with no `SubagentStart`/`SubagentStop`, and admitting them would stick the session on Working. The lead
  `Stop`'s `background_tasks` inventory is authoritative for `subagent`-typed entries (reaps a missed stop,
  re-adds a running one); a `SubagentStop`'s inventory is a stale snapshot and is not reconciled. A
  `UserPromptSubmit` **never** resets the roster — the harness-injected `<task-notification>` prompt arrives
  while sibling agents still run (this was bug 1). Background shells and crons are ignored.
- **`pendingWake`** — background agents that finished but whose result the lead has not picked up yet. When a
  background agent stops, Claude wakes the lead ~80 ms later with a `<task-notification>` prompt naming its task
  id, which opens a new lead turn. The session is held Working across that gap (this was bug 2, the
  done-then-working flicker). The entry clears on the matching `<task-notification>` (prompt `tn`, or its
  transcript record); a wake that never comes degrades to Idle after `WAKE_GRACE_MS` (10 s) of the lead being
  at rest — the grace is measured from `max(finished, lead's last turn end)`, so an agent that finishes while
  the lead is mid-turn is not given up on before Claude can hand its result over. An expired entry is then
  **dropped** (and its id remembered as consumed) at the next event or watcher timer; otherwise every later
  `Stop` would re-arm the grace and hold each turn Working for another 10 s, and the log could never rotate. A
  resumed agent (same id) is re-admitted by its next `SubagentStart`.
- **Waits (Needs input)** — a `PermissionRequest`, or a `PreToolUse(AskUserQuestion)`, held by the lead or by a
  subagent (matched by `agent_id`). A request without `agent_id` is attributed through the open tool calls:
  while the lead works it belongs to the running child that has that exact call (`tool` + `ih`) open — else to
  the lead; after the lead finished it is held by `?`, a running child. Released by the matching tool completion (`tool_use_id` or `tool` + `ih`), the holder's next tool, the
  next prompt, or the turn's end.
- **Conversation boundary.** A new Claude `session_id` is adopted only on a lead `SessionStart` (not
  `compact`) or a lead prompt, which resets the fold; any other event of a foreign conversation is ignored.

`resolveFold` priority: no signal → `Unknown`; `ended` → `Unknown`; any wait → `NeedsInput` (it wins over
running background work); lead `working` → `Working`; roster non-empty → `Working`; a `pendingWake` still
inside its grace → `Working`; else `Idle`. `nextDeadline` tells the watcher when a time-based transition (a
grace expiry) is due.

**The transcript tail** (`claude-transcript.ts`). Two things fire **no** hook: a denied permission and an
interrupt (Esc). Claude does write them to its transcript, so while a lead turn is open (or a lead wait is
held) the watcher tails the transcript named by the hooks' `transcript_path` (last 256 KiB at most) and feeds
three record kinds to `applyTranscript`:
`system/turn_duration` (every lead turn's end; its `pendingBackgroundAgentCount` of 0 clears the roster but
keeps `pendingWake` — whether Claude counts finished-not-yet-handed-over agents is unverified),
a user record `[Request interrupted by user…]` (a turn end of that `promptId`), and a
`task-notification`-origin user record (the wake-up — written ~50 ms BEFORE its `UserPromptSubmit` hook, so it
opens the wake turn itself). `isSidechain` records are skipped. A transcript turn end older than the current
turn's start is ignored, so a lagging tail can never close a newer turn.

**Verified ordering (Claude Code 2.1.x, from live traces).** For a background agent:
`PreToolUse(Agent)` → `SubagentStart` → `PostToolUse(Agent)` (with `tool_response.isAsync`/`agentId`), all
before the lead's `Stop`; the `background_tasks[].id` is the agent id; the wake-up `UserPromptSubmit` follows
the agent's `SubagentStop` by ~80 ms. A `PermissionRequest` carries the same `tool_input` as its `PreToolUse`
but no `tool_use_id`. A denied permission fires no hook and leaves the interrupt marker in the transcript.

**The watcher** (`claude-state-watcher.ts`) is the **sole** source of session state. It folds only **tracked**
sessions, and the runtime-start seam (`deps.prepareClaudeState`, called by `startSessionRuntime` just before the
runtime is created) says how a session's terminal came to be:

- `reset` — a **fresh** PTY: any Claude the log describes is gone, so the log is deleted and the session
  starts `Unknown` (a stale "Working" can never survive into a new shell);
- `attach` — a daemon **re-attach** (§6.2): the Claude in it may still be running, so the whole log
  (`<id>.events.1.jsonl`, then the current file) is replayed and the real state — including running subagents —
  shows at once.

One `fs.watch` on the dir, per-file debounced (~40 ms); each settle reads the log from the last offset (whole
lines; a replaced or shrunk file re-folds from scratch), syncs the transcript tail, emits only on a resolved
state change, re-arms the deadline timer, and — at rest, over 2 MiB — rotates the log to `<id>.events.1.jsonl`
(a rest point is a clean replay boundary). At startup, after hydrate, `pruneClaudeStateDir` deletes the logs of
sessions the workspace no longer holds (and the pre-fold `*.json`/`*.lock` bridge files).

- **Sink.** Each push goes through `deps.onSessionState`, dispatched as `ingestSessionState` on the
  single-writer command loop — never applied inline in the file-change callback.
- **Refresh affordance (R1, §5.4).** `watcher.rescan(sessionId)` — a forced re-fold + re-emit of one
  session's log — wired through `deps.refreshClaudeState`.

`Unknown` is the resting state; transitions are event-driven and emit immediately (the only debounce is the
watcher's write coalescing, and the only timer is the wake grace).

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

- **Raise.** On a `sessionStateChanged` reducing to `Working → Waiting` (Working→Idle), set
  `hasUnseenFinishedTurn[sessionId] = true` **unconditionally** — the on-screen decision is *not* made here.
  The raise is a durable "a turn finished here" marker; whether to *show* the review dot is decided later, at
  display time (see **Validity**). Raising unconditionally is deliberate: on the GPU-less VDI/SwiftShader host
  the focus signal is briefly unreliable at the exact finish instant (§9.7), so gating the raise on focus then
  left a stuck dot for a session the user was actually watching. `Blocked → Waiting` does **not** raise it (the
  user was already being asked; resolving it isn't "new finished work"). A session that goes straight to
  `Waiting` without a prior `Working` (e.g. freshly spawned at a prompt) never raises it — both exclusions fall
  out of the `Working → Waiting` guard.
- **Clear.** This clears the underlying *"looked" memory* (display-time suppression, below, additionally hides
  the dot in the instant before a clear lands). There are two on-screen clear mechanisms:
  - **Bring on screen (focus transition, global).** When the session's tab becomes active
    (`setActiveSession` in its own window, or `activeSessionChanged` in every window) →
    `hasUnseenFinishedTurn[sessionId] = false`. A task switch or a window focus gain does **not** clear here:
    each window marks its own session (§3.7), so only the focused window knows which one is on screen, and
    the watch-in-place clear below handles those (relayed, so also global). This clear is **global** (broadcast to every window's store),
    which also keeps the cross-window task rollup honest: a session on screen in *its own* window is not-focused
    from the main window's perspective, so the display-time gate alone can't suppress its `Review` in the
    main-window rollup — the global clear can.
  - **Watch in place (continuous, relayed global).** A turn that finishes *in place* — the session was already the
    active tab of a focused window — fires **no** focus transition, so the bring-on-screen clear never runs and the
    dot would resurface the moment the user switches away from a session they watched finish. `markVisibleSessionSeen`
    (driven by an effect in `App` on every settled render) closes that gap: it clears the flag for THIS window's
    currently on-screen session (via the same `isSessionFocused` predicate the display uses). It runs against the
    *settled* present-time focus, never the flaky finish instant (§9.7) — the same robustness the display-time gate
    relies on. Because each window knows only its own focus, a local-only clear would leave the **main window's**
    rollup stuck on `Review` for a session watched to end in a *secondary* window (the rollup folds over sessions in
    any window). To close that, the hosting window **relays** the clear: when `markVisibleSessionSeen` clears a flag
    it returns the id, and the `App` effect fires `sessions.markSeen(sessionId)` (fire-and-forget). Main broadcasts a
    `sessionSeen` event to **every** window's store (`windowRegistry.broadcast`), which clears the flag there too.
    Like the §9.5 status-change toast, `sessionSeen` is *synthesized in main and never published on the domain bus* —
    "seen" is a pure renderer view-model (nothing persists, no `TaskState` recompute), so it bypasses the command loop.

  As **defense-in-depth**, the flag is *also* cleared when the session leaves `Waiting` (a `Waiting →
  Working`/`Blocked` transition): once the agent is doing something again the "just finished, unseen" premise no
  longer holds.
- **Validity / supersession (display-time gates).** `sessionDisplayState(session, flag, isOnScreen)` returns
  `Review` **only** for a session that is (a) currently `Waiting` (Idle), (b) flagged, and (c) **not currently
  on screen**. Both gates are evaluated at *consumption*, continuously, on every render — never latched when the
  turn ended:
  - The **idle** gate means any newer non-idle transition (`Working`/`Blocked`) supersedes the flag — the
    session shows that state, not `Review` — so even a flag the store hasn't yet cleared cannot mask a running
    session (fixes the `Working → Waiting → Working` finished-then-resumed dot).
  - The **on-screen** gate (via `isSessionFocused`) means a session the user is looking at never shows `Review`;
    computing it at display time against the *settled* present-time focus value — rather than at the flaky
    finish instant — is what makes it robust on the VDI host (§9.7).
- **Display level & task rollup.** The icon shown (session and task) is a `DisplayState` with priority
  `NeedsInput > Review > Working > Idle > None`. `sessionDisplayState(session, flag, isOnScreen)` gives one
  session's level (with the gates above); `taskDisplayState(taskId)` is the **max** over the task's sessions
  (each passed its own `isSessionFocused`) — replacing the old `taskReadyForReview` OR-selector, which was
  independent of `TaskState` and so could show `Review` while a sibling (or the same session) was `Working`.
  `NeedsInput` still wins over `Review` (a blocked session demands action before a finished one wants a look).
  See §3.4.
- **Non-goals / bounds.** Not persisted (§5.4 — restart starts clean), not in any DTO, not aggregated by the
  domain, never in `sessionStateChanged`. It is pure UI memory keyed off events the store already receives, so
  it needs **no** backend, port, or protocol change — only store reducer logic + the icon variant (§5.4). The
  focus signal it needs (which session is active in which window) is already in the store (§5.2, §5.6).

### 9.5.1 Status-change notification (in-app toast)

Alongside the passive ready-for-review dot, a state change raises an **active** cue: a top-right info toast so
the user notices a session changed even while looking elsewhere. It is deliberately minimal and does **not**
try to reconstruct a `from → to` delta:

- **Stateless message.** The toast is a bold **"State changed"** title over a `<Task> - <Session>` body — no
  old/new state. The user glances at it and checks the session themselves. This is a direct response to
  Claude's hook timing: one logical change often surfaces as **two** genuine states an arbitrary gap apart
  (e.g. `Working → NeedsInput → Working` around a quickly-approved permission, or a turn that ends and is
  promptly re-opened). A `from → to` toast double-fired or showed a stale delta; a stateless "something changed,
  go look" cue sidesteps the race entirely. `SessionStateNotification` (the application-layer sink payload) and
  its `SessionStateNotificationEventDTO` therefore carry **only names**, never states.
- **Fire on a meaningful transition.** `ingestSessionState` calls the `onSessionStateNotification` sink on any
  transition that is not `Unknown → X`, `X → Unknown`, or a no-op (it still keeps a *local* `from` for the
  transition guard and the §11 state log — it just doesn't send it). The use-case stays window/settings-unaware.
- **Per-session leading-edge throttle — in the RENDERER.** A burst (the `Working → Waiting → Blocked`
  double-write, or a mid-turn permission flip) must collapse to **one** toast. The throttle emits the first
  change immediately, then drops further changes for that session for a cooldown window (6 s) **without
  re-arming** — so the window is anchored to the last toast the user *actually saw*, not the last emit attempt.
  Critically it lives in the renderer store (`store/notification-throttle.ts`, an `admit(sessionId)` gate
  consulted inside the reducer), **not** in main: whether a toast is shown depends on per-window focus
  suppression (below) that only the renderer knows. A main-side throttle armed the window on every *attempt*,
  so a focus-suppressed `Waiting → Working` (the user pressed Enter while watching) started a cooldown that
  swallowed the later `Working → Waiting` "it finished" toast — the "I don't always see the toast" bug. Each
  window has its own store, so the throttle is naturally per-window.
- **Suppress when already looking.** The reducer drops the toast when `isSessionFocused(sessionId)` — the same
  authoritative "on screen right now" predicate ready-for-review uses (this window has OS focus, hosts the
  session, and it's the active tab of the active task). Deciding this in the renderer (not from main's racy
  `getFocusedWindow()` snapshot at ingestion) makes it symmetric across both transition directions.
- **Delivery.** Main gates on the `terminal.statusChangeNotifications` setting (default on — only an explicit
  `false` suppresses), routes the DTO to the focused window (main-window fallback) via a direct
  `windowRegistry.sendTo` (never broadcast — it's not a bus event), and forces `webContents.invalidate()` so
  the passive DOM update actually paints on the GPU-less VMware VDI (SwiftShader won't repaint a passive
  mutation until some input wakes it, §6.7). The renderer then makes the final show/suppress/throttle decision.
- **Non-goals.** Like ready-for-review: not persisted, not aggregated by the domain, touches only the toast —
  tab/task **icons** update instantly off the separate `sessionStateChanged` path regardless of the throttle.

### 9.6 Where detection runs: out-of-band, backend-agnostic

State detection **does not read the PTY at all** and is **not a runtime concern** — neither backend
participates. The Claude hook recorder (§9.1) runs as Claude's own hook subprocesses, entirely outside
Octopus's process tree, and appends to each session's events log; the single app-side `ClaudeStateWatcher`
(§9.3, in Electron main) folds those logs and feeds `ingestSessionState` on the command loop. This is
identical whether the PTY lives in `octopusd` or in-process, so `SessionRuntime` carries **no state seam** and
the daemon protocol carries **no state message** — both were removed when this replaced the earlier
socket/composite design. The one runtime-adjacent seam is `deps.prepareClaudeState(id, 'fresh' | 'resume')`,
called by `startSessionRuntime` (an application use case, not the runtime) so the watcher knows whether a
terminal is new or re-attached (§9.3).

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

### 9.7 Known limitations (verified edges)

State is folded from signals Claude Code was never designed to export as a state machine. The fold classifies
the recorded live traces exactly (fixture tests), but the following edges remain, ordered by user impact.

- **A crashed / killed subagent can hold Working.** A subagent that ends with no `SubagentStop` stays in the
  roster until the lead's next `Stop` inventory (or a `turn_duration` with no pending agents) reaps it — a
  deliberate trade to never show "done" prematurely. A reaped *background* agent still gets the wake grace.
- **Esc while background agents run is unverified.** An interrupt that kills running agents is expected to show
  in `turn_duration`'s `pendingBackgroundAgentCount` (→ roster cleared); if Claude keeps them running the
  session correctly stays Working.
- **Denied permission / Esc depend on the transcript format.** Neither fires a hook; both are read from the
  transcript tail (§9.3). A Claude version that changes the interrupt marker or `turn_duration` would leave a
  denied prompt on Needs input until the next prompt. Verified on Claude Code 2.1.x.
- **An approved permission stays `NeedsInput` until the tool finishes.** Claude fires no hook when the user
  approves; the next signal is the tool's `PostToolUse` (or the holder's next tool). A long command run after
  approval (e.g. a 2-minute test suite) therefore shows Needs input throughout. Denial and Esc are read from the
  transcript (below); approval writes nothing there either until the tool result.
- **Whether a subagent's `PermissionRequest` carries `agent_id` is unverified.** If it does not, the request is
  attributed through the open tool calls (the child with that exact call open), else to the lead while it is
  working, or to `?` (a running child) once the lead is done; it shows Needs input and is released by the
  matching tool completion.
- **A user `Stop` hook that makes Claude continue** shows a brief Idle between the two halves (the revive gate
  accepts the same-prompt continuation).
- **Hooks installed mid-session → `Unknown`** until that Claude's next event that the fold admits (Claude reads
  hooks at its start).
- **Silent degradation to `Unknown`.** Every hook is `… 2>/dev/null || true` and the recorder swallows all
  errors (§9.2), so any of: `python3` absent from PATH, `OCTOPUS_SESSION_ID` not surviving into the hook
  subprocess env, or a Claude version renaming an event — degrades the affected session to `Unknown` with no
  error surfaced. This is the intended graceful-degradation posture.
- **An external same-inode rewrite of a log** that is not smaller than the read offset is not detected as a
  replacement (only the recorder ever writes the logs, and it only appends).
- **Ready-for-review on the cross-window task rollup (resolved).** A session that finishes a turn *in place* in a
  focused *secondary* window fires no focus transition, and each renderer knows only its own OS focus — so the
  **main** window's `taskDisplayState` (which folds over sessions in any window) once rolled `Review` onto the task
  even though the user watched the turn end there. This is now fixed by the **watch-in-place relay** (§9.5): the
  hosting window's `markVisibleSessionSeen` reports the clear via `sessions.markSeen`, and main broadcasts a
  `sessionSeen` event that clears `hasUnseenFinishedTurn` in every window's store, including the main window's
  rollup. The relay is fire-and-forget and off the domain bus (a pure view-model sync), so it adds no command-loop
  traffic.

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

- Implement the **out-of-band Claude hook recorder** (§9.1): one stdlib-only python3 script, embedded in TS and
  written to the data dir on startup, wired into Claude's lifecycle hooks + statusline via a merge-safe edit of
  `~/.claude/settings.json` (§9.2, §12.1). It appends to a per-session events log keyed by
  `OCTOPUS_SESSION_ID`; the app-side fold (§9.3) resolves the state. Flip Terminal's `EvaluatesState` on.
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
| R1 | State-detection reliability | High | Status is Claude-only, sourced out-of-band from Claude's own hooks + statusline (§9.1, §9.2) — no PTY parsing, no heuristic. A pure fold over an append-only log, tested against recorded live traces; the revive gate stops a stray post-`Stop` event resurrecting Working; the transcript tail covers a denied permission / Esc (no hook); a daemon re-attach replays the log; `ClaudeStateWatcher.rescan` is the manual "refresh state" affordance; log every transition. |
| R2 | PTY performance with many sessions | Med | Single epoll loop; output batching (leading-edge + 3 ms trailing coalesce, §6.6); state detection is off the PTY path entirely (§9.6 — external hook recorder + file watches), so it adds nothing to the hot path. |
| R3 | Worktree provisioning safety (repo-local script **or** native git) | High | Validate the resulting path (absolute, exists, is a directory; warn if not a git worktree); containment check before delete (exactly the stored path, not `/`/`repoDir`/an ancestor); 30 s timeout; show command output; **all inputs passed as argv — no shell interpolation** for both scripts and native git (I17). |
| R4 | Keeping many sessions alive / crash loses agent work | Med | Phase 1 accepts loss + fresh-shell restore; durable backend (tmux/daemon) is the phase 2+ mitigation behind `SessionManager`; warn on quit if Working/Blocked. |
| R5 | Security (air-gapped on-prem): events-log trust, secrets | Med | The recorder only parses JSON and appends — nothing from Claude's payloads is ever executed, and prompt text is never stored; the fold reads a small set of known fields and ignores unknown events; `~/.claude/settings.json` edits are merge-safe and tagged (`#octopus-state`), never clobbering the user's config; secrets only via keychain (`credentialsRef`), never in the store/JSON. |
| R6 | Bridge failure degrades gracefully | Low–Med | Every hook is `… 2>/dev/null \|\| true` and the bridge wraps every write; a failure is a silent no-op (session stays `Unknown`) and the user's statusline still renders (the bridge chains to their saved original). |
| R7 | State flicker | Low | Claude-only, event-driven from discrete hook/transcript observations (§9.3): the only timer is the bounded wake grace. Background agents and their wake-up hand-off are held Working; the revive gate prevents a stale event from flipping a finished session. |
| R8 | (phase 1.5) Cross-window move race — window moved between drop and `windowAtPoint`, or overlapping unmount/mount | Low | Hit-test is best-effort; worst case the session lands in the wrong window and is re-draggable. Source/target renderers are separate processes, so a brief double-sink during the move overlap cannot collide; the `pty-router` pending buffer covers the pre-mount gap (§6.7). |
| R9 | (phase 1.5) Quit blocked by the secondary-window close dialog | Low | `before-quit` sets an `isQuitting` flag; the secondary `close` handler skips its dialog when quitting, so `Ctrl+Q` runs the normal graceful shutdown (§6.7). |
| R10 | (phase 1.5) Persisted window off-screen after a monitor change | Low | On restore, clamp any window intersecting no display work area to the nearest display (`screen.getAllDisplays()`), preserving size (§6.3). |

**Observability:** structured JSON state-transition log at `~/.local/share/octopus/state.log`;
keyboard-toggled debug overlay showing the last N transitions per session (reason + observation source).

**Testing strategy:** unit (the REAL python3 recorder shelled out against a golden recorded trace; the pure fold
replayed over recorded live hook + transcript traces in `test/fixtures/claude-state/`; aggregation combinations —
python tests skip-if-no-python3); integration (end-to-end: real recorder appends → real `ClaudeStateWatcher` →
sink, including both background-agent regressions, fresh-vs-re-attach, and a denied permission via the
transcript); e2e (real Claude Code with the
injected hooks → assert Working/Blocked/Idle). Worktree scripts tested against a throwaway repo with a fake
create/delete script.

**Performance targets:** PTY read→render <5 ms; hook→log-append <20 ms; file-change→task icon
<100 ms (fs.watch + ~40 ms coalescing debounce, §9.3); Jenkins poll 10 s; per-session events log rotated at rest over 2 MiB.

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
   source branch, and new branch (prefilled with a slug from the name, e.g. `feature/add_feature_1`; editable).
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
