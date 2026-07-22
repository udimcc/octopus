# Project Octopus — Task Breakdown

> **Companion to:** [`PRD.md`](./PRD.md) · [`DESIGN.md`](./DESIGN.md)
> This document decomposes the design into actionable, version-scoped tasks. Every task references the
> design/PRD section that governs it. The organizing principle (DESIGN §10) is: **define interfaces/enums in
> V1; add implementations in V2/V3 — signatures never change across versions.**

## How to use this document

- Tasks are grouped **by version**, then **by architectural layer** (Domain → Application → Ports/Adapters →
  Infra/IPC → UI → Testing), matching the hexagonal structure in DESIGN §2.
- `[ ]` = todo, `[~]` = in progress, `[x]` = done. Sub-bullets are acceptance criteria / notes.
- **V1 "seam" tasks** are load-bearing: they wire dormant hooks that V2/V3 fill. They are explicitly called out
  so V2/V3 stay additive.

---

## V0 — Project Foundation & Bootstrap

Prerequisite scaffolding before any V1 feature. Not a released version.

### Tooling & build
- [x] Initialize Electron + React 18 + TypeScript project via **electron-vite** (DESIGN §4).
  - electron-vite pinned to **3.1.0** (v4/5 need Node ≥20.19; host is 20.17); Electron 33, vite 5.4.
- [x] Configure **electron-builder** for offline/air-gapped production builds (no runtime network) (DESIGN §4, §11).
  - `electron-builder.yml`: `electronDownload.mirror` → internal Artifactory; Linux `dir` target
    (AppImage/deb helper binaries deferred to V1 behind `ELECTRON_BUILDER_BINARIES_MIRROR`).
- [~] Vendor all npm dependencies for air-gapped install; verify no build-time or runtime network access.
  - Install works fully offline-of-GitHub via the internal Artifactory mirror (`.npmrc` `electron_mirror`);
    `package-lock.json` committed. **Not** true tarball vendoring — still depends on the internal registry
    being reachable. Revisit if a fully self-contained offline cache is required.
- [x] Set up the three-process split scaffold: **main**, **preload**, **renderer** (DESIGN §5.5).
- [x] Configure linting/formatting (ESLint 9 flat + Prettier), `tsconfig` with `strict: true`.
- [x] Set up test runner (Vitest: node + jsdom projects) and CI-runnable test scripts (DESIGN §11 testing strategy).

### Composition root & dependency rule
- [x] Establish the **composition root** (`src/main/composition-root.ts`) as the only place that knows concrete adapters (DESIGN §2).
- [x] Enforce dependency rule `UI → Application → Domain`; domain depends on nothing (`eslint-plugin-boundaries`; verified a violating import fails lint).
- [x] Create the port/adapter folder layout (`domain/`, `application/`, `ports/`, `adapters/`; UI lives in `renderer/`).

### Runtime environment
- [x] Raise `RLIMIT_NOFILE` to 65536 at startup (default 1024 exhausted by dozens of PTYs) (DESIGN §6.1).
  - `src/adapters/env/raise-file-limit.ts` via `prlimit(1)`, Linux-only, best-effort, runs before any spawn.
- [x] Set XDG/AppData data paths for DB + logs (`$XDG_DATA_HOME/octopus/`, `%APPDATA%\octopus\`) (DESIGN §6.3).
  - `src/adapters/env/paths.ts`; dirs created at startup (no consumers until V1/V2).

---

## V1 — Tasks, Sessions, Progress Window, Terminal (no state)

Goal (PRD §Versioning V1): tasks, sessions, progress window, terminal session type, **no state indicators**.

### Domain (pure, no dependencies) — DESIGN §3

- [ ] `Workspace` aggregate — `tasks: OrderedMap<TaskId,Task>`, `activeTaskId?`, `config: WorkspaceConfig`; owns
  "at most one active task" rule (DESIGN §3.2, I9).
- [ ] `Task` aggregate root — `id`, `name`, `worktree: WorktreeRef`, `sessions: OrderedList<Session>`,
  `activeSessionId?`, `lifecycle`, `state` (derived), timestamps (DESIGN §3.2).
- [ ] `Session` entity — `id` (globally unique), `taskId`, `typeId`, `title`, `config`, `lifecycle`,
  `state` (default `Unknown`), `runtimeRef?`, `order` (DESIGN §3.2).
- [ ] `WorktreeRef` value object — `path`, `branch?`, `baseRef?`, `provisionedBy`; **immutable once set** (I2).
- [ ] `SessionType` registry descriptor — `typeId`, `displayName`, `icon`, `availableFromVersion`,
  `configSchema`, `capabilities: Set<Capability>`, runtime factory ref (DESIGN §3.2, §8).
- [ ] `SessionConfig` value objects — fully serializable; Terminal: `{ shell?, initialCommand?, cwdOverride? }`
  defaulting to worktree path (DESIGN §3.2).
- [ ] **State enums** `SessionState`/`TaskState` `{ Unknown, Waiting, Working, Blocked }` + internal sub-states
  (defined now, all `Unknown` in V1) (DESIGN §3.3, §10 V1).
- [ ] `TaskLifecycle` state machine: `None → Provisioning → Ready → Deleting → Deleted`, plus
  `ProvisionFailed` / `DeleteFailed` branches (DESIGN §3.5).
- [ ] `SessionLifecycle` state machine: `None → Created → Starting → Running → Stopping → Closed`, plus
  `CreateFailed` / `StartFailed` (DESIGN §3.6). Orthogonal to `SessionState`.
- [ ] `TaskStateAggregator` strategy — pure worst-status-wins `max` over `Blocked>Working>Waiting>Unknown`;
  empty/all-unknown → `Unknown` (DESIGN §3.4). **In V1 always yields `Unknown`.**
- [ ] Enforce invariants I1–I12 in domain logic (DESIGN §7); unit-test each.

### Application layer — DESIGN §6.6, §10 V1

- [ ] **Single-writer command loop** — all domain mutations are commands on one logical writer; adapters do I/O
  off-thread and feed results back as events; no locks around aggregates (DESIGN §6.6).
- [ ] `EventBus` port — already carries `sessionStateChanged` / `taskStateChanged` events (**emitted by nobody
  in V1** — dormant seam) (DESIGN §10 V1 seams).
- [ ] Use case: **`CreateTask(name, branch)`** — run `WorktreeProvider.create`, validate path, persist, add task
  (DESIGN §3.5, §6.4, §12.3).
- [ ] Use case: **`DeleteTask{force?}`** — strict order: stop/dispose all sessions → run delete script → remove
  task, in `Deleting` state (I3, DESIGN §6.6 task-delete ordering).
- [ ] Use case: **`SwitchTask`** — changes only `activeTaskId`/visibility, never session lifecycle (I9).
- [ ] Use case: **`OpenSession(type, cfg)`** — validate cfg against `configSchema` → `Starting` →
  `runtime.start()` (DESIGN §3.6, §8).
- [ ] Use case: **`CloseSession`** — SIGHUP, 2 s, SIGKILL; retain scrollback; dispose (DESIGN §6.1).
- [ ] Use cases: **`RenameTask`**, **`ReorderTask`**, **`RenameSession`**, **`ReorderSession`** (DESIGN §6.5).
- [ ] Use case / query: **`GetState`** (`app:getInitialState`) for renderer hydration (DESIGN §5.2).
- [ ] Use case: **`UpdateSettings`**.
- [ ] Startup **reconciliation**: verify each task's worktree path exists → else mark `Stale`/degraded, don't
  start sessions (I14, DESIGN §6.3).
- [ ] App quit sequence: SIGHUP all PTYs, `PRAGMA wal_checkpoint(TRUNCATE)`, quit; warn if any session
  Working/Blocked (I13, DESIGN §6.6). *(Working/Blocked warning is degenerate in V1 — all Unknown.)*

### Ports & Adapters — DESIGN §6, §10 V1

- [ ] `WorktreeProvider` port + **`ShellScriptWorktreeProvider`** adapter (DESIGN §6.4).
- [ ] `ScriptRunner` port + adapter — explicit cwd, **no shell-string interpolation of untrusted names** (pass
  args safely), timeouts, captured exit/stderr (I17, R3).
- [ ] **Worktree create contract** — `createWorktree <task-name> <branch-name>`; cwd `$OCTOPUS_REPO_ROOT`; env
  `OCTOPUS_REPO_ROOT`/`OCTOPUS_TASK_ID`/`OCTOPUS_VERSION`; first stdout line = abs path; exit 0 = success;
  30 s timeout → SIGTERM/2 s/SIGKILL (DESIGN §6.4).
- [ ] **Path validation** — absolute, exists, is directory; store verbatim; optional (non-rejecting) git-worktree
  warning; best-effort rollback via delete script on failure (DESIGN §6.4, §12.4).
- [ ] **Worktree delete contract** + safety checks — path sanity (exactly the returned path; not `/`, not
  `OCTOPUS_REPO_ROOT` nor ancestor), uncommitted-changes check (`git status --porcelain`), all sessions killed
  first; stderr (≤64 KB) surfaced (DESIGN §6.4, I4).
- [ ] `SessionManager` / `SessionRuntime` ports + **`PtyTerminalRuntime`** (node-pty) — `start()/stop()/dispose()`,
  type-neutral output/interaction handle, `stateEvaluator()` **returns null in V1** (DESIGN §6.2, §8, §10 V1).
- [ ] PTY spawn config — login shell (`-l`), `cwd` = worktree path, `TERM=xterm-256color`,
  `COLORTERM=truecolor`, `OCTOPUS_*` env, strip `TMUX/STY/WINDOWID` (DESIGN §6.1).
- [ ] PTY resize — `ResizeObserver` (debounced ~50 ms) → `fit()` → `pty:resize` → `pty.resize` → `TIOCSWINSZ`
  (DESIGN §6.1).
- [ ] PTY exit handling — node-pty `onExit` reaps child → mark `Exited`, emit `sessionExited`, retain scrollback
  (DESIGN §6.1).
- [ ] `WorkspacePersistence` port + **`SqliteStore`** (better-sqlite3) (DESIGN §6.3).
- [ ] SQLite schema — `tasks`, `sessions` (with `state` default `'unknown'`), `app_state`; `branch`/`repo_root`
  nullable; `sessions.task_id ... ON DELETE CASCADE` (DESIGN §6.3).
- [ ] Persist/restore logic — persist task+session definitions, active task; restore = fresh PTY per terminal
  session at worktree cwd (I15, DESIGN §6.3).
- [ ] `settings.json` sibling file for global settings (`scripts.createWorktree`, `scripts.deleteWorktree`,
  `terminal.shell`, default session type) (DESIGN §6.3, §6.4).
- [ ] Supporting ports: `IdGenerator`, `Clock`, `EventBus` (DESIGN §10 V1).
- [ ] **`CredentialsProvider` port shape defined** (no implementation) so V3 doesn't retrofit secret handling
  (I16, §10 V1 seams).

### Session-type registry — DESIGN §8

- [ ] `SessionTypeProvider` (application edge) — populates the New-Session dropdown purely from the registry
  (filtered by `availableFromVersion ≤ currentVersion`).
- [ ] `SessionViewFactory` (UI, keyed by same `typeId`) — `mount(runtimeHandle, container)` / `unmount()`.
- [ ] Register **Terminal** type statically (`EvaluatesState` **off** in V1) at the composition root (§10 V1).

### IPC — DESIGN §6.5

- [ ] Preload exposes only a typed **`window.octopusAPI`** via `contextBridge`; renderer never touches
  `ipcRenderer`/Node (DESIGN §5.5).
- [ ] Request/reply commands via `ipcMain.handle` with renderer-generated `requestId`: `createTask`,
  `deleteTask{force?}`, `renameTask`, `reorderTask`, `createSession`, `closeSession`, `renameSession`,
  `reorderSession`, `writeToPty`, `resizePty`, `getState`, `updateSettings` (DESIGN §6.5).
- [ ] Streaming `ptyData` via `webContents.send` (avoid head-of-line blocking) (DESIGN §6.5).
- [ ] Backend→UI events: `ptyData`, `sessionCreated`, `sessionExited`, `sessionClosed`, `taskCreated`,
  `taskDeleted`, `taskRenamed`, `taskStale`, `scriptProgress`, `scriptError`, `error`; plus
  `sessionStateChanged`/`taskStateChanged` **defined but dormant** (DESIGN §6.5, §10 V1).
- [ ] Keep message set transport-agnostic (V2 daemon can carry it over a Unix socket unchanged) (DESIGN §6.5).

### Concurrency & resilience — DESIGN §6.6

- [ ] **Output batching / back-pressure** — per-session accumulator flushed on 16 ms (60 Hz) timer or at 256 KB
  cap (DESIGN §6.6).
- [ ] **Inactive tabs** — don't send `ptyData`; append to per-session ring buffer (~500 KB) and replay on tab
  activation (DESIGN §6.6, §5.3).
- [ ] V2+ note: spawn each shell via `setsid` (group-kill descendants) — *defer to V2* (DESIGN §6.1). *(V1 uses
  SIGHUP/SIGKILL to the single PTY.)*

### UI (Renderer) — DESIGN §5

- [ ] **Zustand store** — `tasks`, `sessions`, `activeTaskId`, `activeSessionId` (per task). **`ptyData` bypasses
  the store**, delivered by IPC directly to the target `TerminalPane` (DESIGN §5.2).
- [ ] Startup hydration via `app:getInitialState`; thereafter lifecycle events patch the store (DESIGN §5.2).
- [ ] Component tree scaffold: `App → ProgressPanel + TaskWorkspace` (DESIGN §5.1).
- [ ] **`ProgressPanel`** — `PanelHeader (NewTaskButton, DeleteTaskButton)` + `TaskList → TaskListItem*`
  (label only in V1; `TaskStatusIcon` is V2) (DESIGN §5.1, PRD §Progress Window).
- [ ] **`TaskWorkspace → TaskView*`** — one per task; **all mounted, only active visible** (DESIGN §5.1, §5.3).
- [ ] **`SessionTabBar`** — `NewSessionDropdown` (registry-driven) + `SessionTab*` (no status icon in V1) (DESIGN §5.1).
- [ ] **`SessionPaneArea → SessionPane*`** — `TerminalPane` (JenkinsPane is V3) (DESIGN §5.1).
- [ ] **`TerminalPane`** — xterm.js instance created once in `useRef`/`useEffect([])`, never destroyed until
  session close (DESIGN §5.3).
- [ ] xterm.js addons: `fit`, `webgl` (canvas fallback), `search`, `web-links`, `unicode11`, `serialize`;
  scrollback bounded ~10 000 lines (DESIGN §4, §5.3).
- [ ] **Keep-alive on task switch (critical)** — hidden sessions use `visibility:hidden; position:absolute;
  width/height:0` (NOT `display:none`); `terminal.write` keeps running for hidden sessions (DESIGN §5.3).
- [ ] On show: `fitAddon.fit()` → `pty:resize` → `terminal.refresh(0, rows-1)`; on hide: nothing (DESIGN §5.3).
- [ ] **WebGL context scale mitigation** — above ~15 concurrent sessions, demote hidden terminals to Canvas
  renderer (DESIGN §5.3).
- [ ] Data flow wiring: keystroke `xterm onData → octopusAPI.pty.input → ipcMain → pty.write`; output
  `pty onData → batched → send('pty:data') → terminal.write` (DESIGN §5.2).
- [ ] **New Task modal** — name + branch (branch prefilled with slug from name, e.g. `feature/add-feature-1`);
  spinner during create script; on success task becomes active/empty; on failure red stderr block + Retry +
  toast (DESIGN §5.4, §12.3).
- [ ] **New Session dropdown** — populated from registry; Terminal creates immediately (DESIGN §5.4).
- [ ] **Delete Task** — confirm dialog ("closes all sessions and removes the worktree"); extra "uncommitted
  changes — delete anyway?" confirmation on dirty worktree (DESIGN §5.4).
- [ ] **Tabs UX** — horizontal scroll + chevrons on overflow; "…" overflow menu beyond ~8 tabs; drag-reorder via
  `@dnd-kit/core`; per-tab `×` close (fires `pty:destroy`) (DESIGN §5.4).
- [ ] **Keyboard shortcuts** — `Ctrl+Shift+]`/`[` cycle tasks; `Ctrl+Tab`/`Ctrl+Shift+Tab` cycle sessions;
  `Ctrl+Shift+T` new terminal; `Ctrl+Shift+N` new task; `Ctrl+Shift+W` close session; `Ctrl+Shift+F` search;
  `Ctrl+Shift+C/V` copy/paste; `Esc` close modal. **Only Shift-modified shortcuts intercepted globally** so
  terminal `Ctrl+C` is never stolen (DESIGN §5.4).
- [ ] **Empty states & toasts** — "No tasks yet", "No sessions", inline "Connecting…"; bottom-right toasts for
  script failures / unexpected PTY exit (DESIGN §5.4).

### V1 dormant seams (explicit — must exist, unused) — DESIGN §10 V1

- [ ] `capabilities.EvaluatesState` present (Terminal **off**).
- [ ] `SessionRuntime.stateEvaluator()` returns `null`.
- [ ] `EventBus` carries state events (dormant).
- [ ] Aggregator called but yields `Unknown`; UI renders **no icons**.
- [ ] View resolution keyed by `typeId`.
- [ ] `SessionConfig` validated against `configSchema`.
- [ ] `OCTOPUS_STATE_SOCKET` env + per-session socket dir `/tmp/octopus-<uid>/` (`chmod 700`) **provisioned but
  unused** (DESIGN §9.2, §10 V1).
- [ ] `CredentialsProvider` port shape defined.

### V1 Testing — DESIGN §11

- [ ] Unit: aggregation combinations (all yield `Unknown` in V1), lifecycle state machines, invariants I1–I12.
- [ ] Unit: path validation & delete safety-check logic (containment, sanity).
- [ ] Integration: create/delete against a throwaway repo with fake create/delete scripts.
- [ ] Integration: PTY spawn at correct cwd, resize, exit/scrollback retention.
- [ ] Integration: restart reconciliation (worktree missing → `Stale`; present → fresh shell).
- [ ] E2E smoke: create task → open terminal → run command → switch task (buffer preserved) → delete task.

---

## V2 — Session State + Aggregation + Icons

Goal (PRD §Versioning V2): session-state evaluation/display, task state derived from sessions, status icons in
progress window and tabs. **No new ports, no domain signature changes** (DESIGN §10 V2).

### State-detection subsystem — DESIGN §9

- [ ] `StateProvider` interface — `initialize(ctx)`, `poll()`, `get_state() → StateSnapshot{state, confidence,
  assessed_at, reason, layer}`, `teardown()`; confidence ∈ {Authoritative, High, Medium, Low, None} (DESIGN §9.3).
- [ ] **`TerminalHeuristicProvider`** (Layers 1+2):
  - [ ] Layer 2: OSC 133 semantic prompt marks (A/B prompt, C command-start, D;exit) (DESIGN §9.1).
  - [ ] Layer 2: `tcgetpgrp(master_fd)` vs shell PGID (foreground=at prompt; child=running); polled 200 ms (DESIGN §9.1, §9.3).
  - [ ] Layer 1: PTY output-activity timing (1 s check) as tie-breaker only (DESIGN §9.1, §9.3).
  - [ ] O(1)/byte OSC parser reusing a hardened parser (xterm.js's); cap param length 1 KB + sequence timeout;
    never propagate parse errors to renderer (R6).
- [ ] **`ClaudeCodeProvider`** (Layer 3, authoritative — the only reliable `Blocked`) (DESIGN §9.2):
  - [ ] Per-session Unix socket `/tmp/octopus-<uid>/session-<uuid>.sock` (dir `chmod 700`); export
    `OCTOPUS_STATE_SOCKET`; async listen (activate the V1 seam).
  - [ ] Message validation — ≤1 KB, valid JSON, known state values; **nothing from a message is ever executed** (R5).
  - [ ] Graceful degradation — socket unset/gone → `nc` fails silently → fall back to heuristic.
  - [ ] OSC 9000 in-band state escape sequence support (DESIGN §9.1).
- [ ] **`CompositeStateProvider`** — combines `TerminalHeuristicProvider` + `ClaudeCodeProvider` applying §9.1
  decision logic:
  - [ ] Layer 3 if signal within `T_explicit` (30 s, refreshed per signal); else Layer 2; else Layer 1.
  - [ ] `Blocked/Heuristic` only when Layer 2=Working + foreground is Claude Code (`/proc/<pgid>/comm`) + PTY
    silent >8 s → render dimmed/pulsing.
  - [ ] Conflict: fresh Layer 2 `D` overrides **stale** Layer 3 Working; degrade Layer 3 → Layer 2 after
    `T_stale` = 60 s.
- [ ] **Internal sub-states** wired to confidence scoring (not UI): `Waiting/AtPrompt`, `Waiting/Explicit`,
  `Working/Subprocess`, `Working/Explicit`, `Blocked/Permission`, `Blocked/Explicit`, `Blocked/Heuristic`,
  `Initializing`→Working (DESIGN §3.3, §9).
- [ ] **Debounce/hysteresis** — min 500 ms hold; `Working→Waiting` needs 1 s stability; `Waiting→Working`
  immediate; **`Blocked` immediate (no debounce)**; `Unknown` emitted once at start; task aggregation debounced
  300 ms except Blocked (DESIGN §9.3).

### Auto-injection (opt-out) — DESIGN §12.1

- [ ] Inject **OSC 133 shell integration** into Octopus's own terminals via `--rcfile`/profile snippet that
  **sources the user's own rc first** (never edits `~/.bashrc`) (DESIGN §9.1, §12.1).
- [ ] Write Claude Code hooks into `<worktree>/.claude/settings.json`, **merging with — never clobbering —** an
  existing file (DESIGN §9.2, §12.1):
  - `Stop` → `{"state":"waiting","reason":"claude_stop"}`
  - `PreToolUse` → `{"state":"blocked","reason":"permission_request","tool":"…"}`
  - `PostToolUse` → `{"state":"working","reason":"tool_use","tool":"…"}`
- [ ] Provide an opt-out setting for auto-injection.

### Application / Domain wiring — DESIGN §10 V2

- [ ] Flip Terminal's **`capabilities.EvaluatesState` on**; `SessionRuntime.stateEvaluator()` now returns the
  composite provider.
- [ ] Runtime emits **`sessionStateChanged`** on the `EventBus` (push-based); Application ingests it via the
  single-writer loop (DESIGN §8, §6.6).
- [ ] `TaskStateAggregator` now produces real aggregate states; recompute on session add/remove and on each
  ingested `sessionStateChanged` (pure `max` → cannot drift) (I11, §3.4).
- [ ] `Exited`/`StartFailed` session maps to `Blocked` for aggregation; no-`EvaluatesState` session → `Unknown`
  and transparent unless sole signal (I12).
- [ ] Emit `taskStateChanged` view-model events to the renderer.
- [ ] *(Optional infra)* Spawn shells via `setsid` so group SIGKILL kills descendants (DESIGN §6.1).

### UI — DESIGN §5.4, §10 V2

- [ ] **`TaskStatusIcon`** in `TaskListItem` and **`SessionStatusIcon`** in `SessionTab` (DESIGN §5.1).
- [ ] Icon design — shape **and** color: Waiting = hollow/pause, gray; Working = spinner/filled, blue;
  Blocked = warning triangle, amber; low-confidence states dimmed/pulsing; tooltips with plain-text
  descriptions (DESIGN §5.4).
- [ ] Zustand: add `sessionStatuses` + derived `taskStatuses` selector applying §3.4 (DESIGN §5.2).
- [ ] Wire `session:status`/`taskStateChanged` events → `store.updateSessionStatus` → icons re-render (DESIGN §5.2).
- [ ] Manual **"refresh state"** affordance (R1).
- [ ] App-quit warning becomes meaningful: warn on quit if any session Working/Blocked (I13).

### Observability — DESIGN §11

- [ ] Structured JSON **state-transition log** at `~/.local/share/octopus/state.log` (every transition w/
  layer + confidence + reason) (R1, DESIGN §11).
- [ ] Keyboard-toggled **debug overlay** showing last N transitions per session (source layer + reason).

### Optional V2 infra (only if process-survival prioritized) — DESIGN §6.2, §12.2

- [ ] `DaemonSessionManager` (or tmux backend) behind the existing `SessionManager` port — server-side ring
  buffer (~5 MB/session) replayed on re-attach; **renderer unaffected** (DESIGN §6.2).

### V2 Testing — DESIGN §11

- [ ] Unit: OSC parser byte-sequences; §9.1 decision logic; debounce/hysteresis timing (pure).
- [ ] Integration: scripted PTY emitting OSC 133 at known times → assert Working; `sleep` foreground → Working.
- [ ] Integration: direct socket writes → assert `Blocked`.
- [ ] E2E: real Claude Code with hooks → assert Working/Blocked.
- [ ] Failure injection: socket disconnect, no OSC 133 → assert graceful fallback to heuristic.
- [ ] Perf targets: OSC 133→state <10 ms; hook→state <20 ms; Blocked→task icon <50 ms; Working→Waiting <1.5 s;
  state subsystem <1 MB/session (DESIGN §11).

---

## V3 — Jenkins Pipeline Viewer

Goal (PRD §Versioning V3): new session type connecting to Jenkins, showing pipeline progression, reporting
state back to the task. **Zero changes** to Domain, Application use cases, Terminal, or the aggregator
(DESIGN §8 acceptance test, §10 V3).

### Ports & Adapters — DESIGN §9.4, §10 V3

- [ ] `JenkinsClient` port + **`JenkinsHttpClient`** adapter (DESIGN §10 V3).
- [ ] Auth via **`CredentialsProvider`/OS keychain (libsecret)** — never plaintext; resolve `credentialsRef` at
  runtime (I16, R5).
- [ ] `JenkinsProvider` state mapping (poll `<job>/lastBuild/api/json` every ~10 s, configurable) (DESIGN §9.4):
  - `building==true` → **Working**
  - `SUCCESS/UNSTABLE/FAILURE/ABORTED/NOT_BUILT` → **Waiting** (failed pipeline isn't *asking* Octopus → not Blocked)
  - Input step `PAUSED_PENDING_INPUT` (via `/wfapi/describe`) → **Blocked**
  - Never `Unknown` after first successful poll.

### Session type registration — DESIGN §8, §10 V3

- [ ] `JenkinsSessionTypeProvider` — `EvaluatesState` on; `configSchema` = `{ jobPath, branch (defaults to
  worktree branch), credentialsRef }` (DESIGN §3.2, §8).
- [ ] `JenkinsViewFactory` (UI) keyed by `typeId`.
- [ ] Register at composition root — dropdown (filtered by `availableFromVersion`) and aggregation pick it up
  automatically (DESIGN §8).

### UI — DESIGN §5.1, §5.4

- [ ] `JenkinsPane` `SessionPane` rendering pipeline progression for the task's branch.
- [ ] New-Session flow: Jenkins opens a small **config modal** (job/branch/creds) (DESIGN §5.4).
- [ ] Jenkins-error toasts (DESIGN §5.4).

### V3 acceptance / testing — DESIGN §8, §11

- [ ] **Abstraction acceptance test**: adding Jenkins required **zero edits** to `Task`, the aggregator, or the
  dropdown logic (DESIGN §8). If any were needed, the V1 abstraction was wrong — fix upstream.
- [ ] Integration: mocked Jenkins API responses → assert Working/Waiting/Blocked mapping (§9.4).
- [ ] Integration: keychain-backed credential resolution; assert no secret ever persisted to DB/JSON (I16).
- [ ] Perf: Jenkins poll cadence 10 s honored/configurable (DESIGN §11).

---

## Cross-Cutting Checklist (all versions) — DESIGN §7, §11

- [ ] **Invariants I1–I17** upheld and unit-tested where applicable (DESIGN §7).
- [ ] **Trust boundary** — user scripts & terminal commands run via `ScriptRunner`: explicit cwd, no
  shell-string interpolation, timeouts, captured exit/stderr (I17, R3).
- [ ] **Never persist secrets** — keychain-only via `credentialsRef` (I16, R5).
- [ ] **Air-gapped** — all deps vendored; no runtime network access outside Jenkins polling (DESIGN §4).
- [ ] **Performance targets** (DESIGN §11): PTY read→render <5 ms; state timings per V2; icon latency per V2.
- [ ] **Risk mitigations R1–R7** tracked (DESIGN §11).
