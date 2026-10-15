# Project Octopus — Task Breakdown

> **Companion to:** [`PRD.md`](./PRD.md) · [`DESIGN.md`](./DESIGN.md)
> This document decomposes the design into actionable, phase-scoped tasks. Every task references the
> design/PRD section that governs it. The organizing principle (DESIGN §10) is: **define interfaces/enums in
> phase 1; add implementations in phase 2/phase 3 — signatures never change across phases.**

## How to use this document

- Tasks are grouped **by phase**, then **by architectural layer** (Domain → Application → Ports/Adapters →
  Infra/IPC → UI → Testing), matching the hexagonal structure in DESIGN §2.
- `[ ]` = todo, `[~]` = in progress, `[x]` = done. Sub-bullets are acceptance criteria / notes.
- **Phase 1 "seam" tasks** are load-bearing: they wire dormant hooks that phase 2/phase 3 fill. They are explicitly called out
  so phase 2/phase 3 stay additive.

---

## Phase 0 — Project Foundation & Bootstrap

Prerequisite scaffolding before any phase 1 feature. Not a released phase.

### Tooling & build
- [x] Initialize Electron + React 18 + TypeScript project via **electron-vite** (DESIGN §4).
  - electron-vite pinned to **3.1.0** (v4/5 need Node ≥20.19; host is 20.17); Electron 33, vite 5.4.
- [x] Configure **electron-builder** for offline/air-gapped production builds (no runtime network) (DESIGN §4, §11).
  - `electron-builder.yml`: `electronDownload.mirror` → internal Artifactory; Linux `dir` target
    (AppImage/deb helper binaries deferred to phase 1 behind `ELECTRON_BUILDER_BINARIES_MIRROR`).
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
  - `src/adapters/env/paths.ts`; dirs created at startup (no consumers until phase 1/phase 2).

---

## Phase 1 — Tasks, Sessions, Progress Window, Terminal (no state)

Goal (PRD §Phases Phase 1): tasks, sessions, progress window, terminal session type, **no state indicators**.

> **Status (M0–M7 done — phase 1 feature-complete):** the full backend — domain, ports, application (single-writer
> loop, all use cases, reconcile, quit), adapters (PTY runtime, SqliteStore, worktree provider, script runner,
> settings, socket provisioner), IPC, and composition root — is complete and green. The **renderer** is now the
> full `DESIGN §5.1` component tree: `App → ProgressPanel + TaskWorkspace`, with `ProgressPanel` (New/Delete Task,
> settings gear), `NewTaskModal`, `DeleteTaskConfirm` (dirty gate + force-forget), `SettingsModal`, `SessionTabBar`
> + `NewSessionDropdown` (overflow chevrons/menu), `@dnd-kit` drag-reorder for tasks and tabs, double-click inline
> rename, `Toaster`, and Shift-gated keyboard shortcuts. Both scale-mitigations are in: renderer-side ring-buffer
> replay (`pty/pty-router.ts`) and the WebGL→Canvas lease budget (`terminal/webgl-budget.ts`). The two remaining
> test items — restart-reconciliation and the E2E smoke — are done as headless integration tests over the real
> PTY stack. Every phase 1 **dormant seam** (§10) is present and verified unused. `npm run typecheck`, `lint`
> (dependency-rule boundary enforced) and `test` (393 tests, 56 files) are all green. What's left before ship is
> **live `npm run dev` verification on a display** (M7 acceptance walk-through, DESIGN §11 step 5) — not exercised
> in this headless environment.
>
> **Phase 1.5 (multi-window) builds strictly additively on this feature-complete phase 1** — new domain fields, new
> commands/events, and one schema migration; no existing signature changes. See the `Phase 1.5 — Multi-Window`
> section below.

### Domain (pure, no dependencies) — DESIGN §3

- [x] `Workspace` aggregate — `tasks: OrderedMap<TaskId,Task>`, `activeTaskId?`, `config: WorkspaceConfig`; owns
  "at most one active task" rule (DESIGN §3.2, I9).
- [x] `Task` aggregate root — `id`, `name`, `worktree: WorktreeRef`, `sessions: OrderedList<Session>`,
  `activeSessionId?`, `lifecycle`, `state` (derived), timestamps (DESIGN §3.2).
- [x] `Session` entity — `id` (globally unique), `taskId`, `typeId`, `title`, `config`, `lifecycle`,
  `state` (default `Unknown`), `runtimeRef?`, `order` (DESIGN §3.2).
- [x] `WorktreeRef` value object — `path`, `branch?`, `baseRef?`, `provisionedBy`; **immutable once set** (I2).
- [x] `SessionType` registry descriptor — `typeId`, `displayName`, `icon`, `availableFromVersion`,
  `configSchema`, `capabilities: Set<Capability>`, runtime factory ref (DESIGN §3.2, §8).
- [x] `SessionConfig` value objects — fully serializable; Terminal: `{ shell?, initialCommand?, cwdOverride? }`
  defaulting to worktree path (DESIGN §3.2).
- [x] **State enums** `SessionState`/`TaskState` `{ Unknown, Idle, Working, NeedsInput }` (member names; values
  stay wire strings `'waiting'`/`'blocked'`) + internal sub-states (defined now, all `Unknown` in phase 1)
  (DESIGN §3.3, §10 phase 1).
- [x] `TaskLifecycle` state machine: `None → Provisioning → Ready → Deleting → Deleted`, plus
  `ProvisionFailed` / `DeleteFailed` branches (DESIGN §3.5).
- [x] `SessionLifecycle` state machine: `None → Created → Starting → Running → Stopping → Closed`, plus
  `CreateFailed` / `StartFailed` (DESIGN §3.6). Orthogonal to `SessionState`.
- [x] `TaskStateAggregator` strategy — pure worst-status-wins `max` over `NeedsInput>Working>Idle>Unknown`;
  empty/all-unknown → `Unknown` (DESIGN §3.4). **In phase 1 always yields `Unknown`.**
- [x] Enforce invariants I1–I12 in domain logic (DESIGN §7); unit-test each.

### Application layer — DESIGN §6.6, §10 phase 1

- [x] **Single-writer command loop** — all domain mutations are commands on one logical writer; adapters do I/O
  off-thread and feed results back as events; no locks around aggregates (DESIGN §6.6).
- [x] `EventBus` port — already carries `sessionStateChanged` / `taskStateChanged` events (**emitted by nobody
  in phase 1** — dormant seam) (DESIGN §10 phase 1 seams).
- [x] Use case: **`CreateTask(name, repoDir, sourceBranch, newBranch)`** — run `WorktreeProvider.create`,
  validate path, persist, add task; populate `WorktreeRef.branch = newBranch`, `baseRef = sourceBranch`,
  `provisionedBy.repoRoot = repoDir` (DESIGN §3.5, §6.4, §12.3). *(Signature/fields reworked from the
  old `(name, branch)` — see the worktree-provisioning redesign below.)*
- [x] Use case: **`DeleteTask{force?}`** — strict order: stop/dispose all sessions → run delete (repo-local
  script or native git) → remove task, in `Deleting` state (I3, DESIGN §6.6 task-delete ordering). *(Reworked:
  passes the task's stored per-task `repoDir` (`worktree.provisionedBy.repoRoot`), not the global `deps.repoRoot`,
  so delete-after-restart targets the right repo.)*
- [x] Use case: **`SwitchTask`** — changes only `activeTaskId`/visibility, never session lifecycle (I9).
- [x] Use case: **`OpenSession(type, cfg)`** — validate cfg against `configSchema` → `Starting` →
  `runtime.start()` (DESIGN §3.6, §8).
- [x] Use case: **`CloseSession`** — SIGHUP, 2 s, SIGKILL; retain scrollback; dispose (DESIGN §6.1).
- [x] Use cases: **`RenameTask`**, **`ReorderTask`**, **`RenameSession`**, **`ReorderSession`** (DESIGN §6.5).
- [x] Use case / query: **`GetState`** (`app:getState`) for renderer hydration (DESIGN §5.2).
- [x] Use case: **`UpdateSettings`**.
- [x] Startup **reconciliation**: verify each task's worktree path exists → else mark `Stale`/degraded, don't
  start sessions (I14, DESIGN §6.3).
- [x] App quit sequence: SIGHUP all PTYs, `PRAGMA wal_checkpoint(TRUNCATE)`, quit; warn if any session
  Working/Blocked (I13, DESIGN §6.6). *(Working/Blocked warning is degenerate in phase 1 — all Unknown.)*

### Ports & Adapters — DESIGN §6, §10 phase 1

- [x] `WorktreeProvider` port + **`SelectingWorktreeProvider`** adapter composing **`ScriptWorktreeProvider`**
  (repo-local `create_worktree.sh`/`delete_worktree.sh`) and **`NativeGitWorktreeProvider`** (Octopus runs
  git). Port *interface* shape unchanged (§10); request payloads gain `repoDir`/`sourceBranch`/`newBranch`.
  Selector probes `<repoDir>/*.sh` **per call** and delegates (DESIGN §6.4). *(Refactor of the old
  `ShellScriptWorktreeProvider`, which read script paths from global settings.)*
  - [x] Pure **`worktree-path.ts`** — `sanitizeBranchForDir(branch)` + `computeWorktreePath({base,newBranch,taskId})`
    → flat `<base>/<sanitized-new-branch>-<short-task-id>` (mirrors the pure `paths.ts` resolver).
  - [x] Existence probe for `<repoDir>/create_worktree.sh` / `delete_worktree.sh` (model on
    `fs/dir-exists.ts` / `fs-path-probe.ts`).
- [x] `ScriptRunner` port + adapter — explicit cwd, **no shell-string interpolation of untrusted names** (pass
  args safely), timeouts, captured exit/stderr (I17, R3). *(Reused unchanged for native `git` too.)*
- [x] **Worktree create contract** (dual) — repo-local `create_worktree.sh <source-branch> <new-branch>`
  (first stdout line = abs path) **or** native `git -C <repoDir> worktree add -b <new-branch> <computed-path>
  <source-branch>` under `worktree.location`; cwd `repoDir`; env `OCTOPUS_REPO_ROOT`(=`repoDir`)/`OCTOPUS_TASK_ID`/
  `OCTOPUS_VERSION`; exit 0 = success; 30 s timeout → SIGTERM/2 s/SIGKILL (DESIGN §6.4).
- [x] **Path validation** — absolute, exists, is directory; store verbatim; optional (non-rejecting) git-worktree
  warning (DESIGN §6.4, §12.4). *(`path-safety.ts` reused for both providers.)*
- [x] **Worktree delete contract** (dual) + safety checks — repo-local `delete_worktree.sh <task-name>
  <worktree-path>` **or** native `git -C <repoDir> worktree remove <path>` (`--force` when the user confirmed a
  dirty delete); path sanity (exactly the stored path; not `/`, not `repoDir` nor ancestor), uncommitted-changes
  check (`git status --porcelain`), all sessions killed first; stderr (≤64 KB) surfaced (DESIGN §6.4, I4).
- [x] `SessionManager` / `SessionRuntime` ports + **`PtyTerminalRuntime`** (node-pty) — `start()/stop()/dispose()`,
  type-neutral output/interaction handle, `stateEvaluator()` **returns null in phase 1** (DESIGN §6.2, §8, §10 phase 1).
- [x] PTY spawn config — login shell (`-l`), `cwd` = worktree path, `TERM=xterm-256color`,
  `COLORTERM=truecolor`, `OCTOPUS_*` env, strip `TMUX/STY/WINDOWID` (DESIGN §6.1).
- [x] PTY resize — `ResizeObserver` (debounced ~50 ms) → `fit()` → `pty:resize` → `pty.resize` → `TIOCSWINSZ`
  (DESIGN §6.1).
- [x] PTY exit handling — node-pty `onExit` reaps child → mark `Exited`, emit `sessionExited`, retain scrollback
  (DESIGN §6.1).
- [x] `WorkspacePersistence` port + **`SqliteStore`** (better-sqlite3) (DESIGN §6.3).
- [x] SQLite schema — `tasks`, `sessions` (with `state` default `'unknown'`), `app_state`;
  `branch`/`base_ref`/`repo_root` nullable; `sessions.task_id ... ON DELETE CASCADE` (DESIGN §6.3). *(Added
  `base_ref TEXT` to persist the source branch; bumped `SCHEMA_VERSION` 1→2 with a guarded, idempotent
  `ALTER TABLE tasks ADD COLUMN base_ref TEXT` when `user_version < 2` — first use of the migration seam.
  Bumped 2→3 to add the `session_scrollback(session_id PK ON DELETE CASCADE, data)` table for persisted
  terminal output — a guarded, idempotent `CREATE TABLE IF NOT EXISTS` when `user_version < 3`.)*
- [x] Persist/restore logic — persist task+session definitions, active task; restore = fresh PTY per terminal
  session at worktree cwd (I15, DESIGN §6.3). *(Restore also replays each session's persisted scrollback into
  the fresh PTY — see the §6.6 backend ring-buffer entry below.)*
- [x] `settings.json` sibling file for global settings (`worktree.location` base dir — default
  `~/octopus_repos/`, resolved from home via a pure resolver + effectful ensure-dir like `paths.ts`;
  `terminal.shell`; default session type; `worktreeCreateTimeoutMs`) (DESIGN §6.3, §6.4). *(Replaces the old
  `scripts.createWorktree`/`scripts.deleteWorktree` global keys — worktree scripts are now repo-local. Stale
  `scripts` blocks are silently dropped by `mergeSettings`; no settings migration needed.)*
- [x] Supporting ports: `IdGenerator`, `Clock`, `EventBus` (DESIGN §10 phase 1).
- [x] **`CredentialsProvider` port shape defined** (no implementation) so phase 3 doesn't retrofit secret handling
  (I16, §10 phase 1 seams).

### Session-type registry — DESIGN §8

- [x] `SessionTypeProvider` (application edge) — populates the New-Session dropdown purely from the registry
  (filtered by `availableFromVersion ≤ currentVersion`).
- [x] `SessionViewFactory` (UI, keyed by same `typeId`) — `mount(runtimeHandle, container)` / `unmount()`.
- [x] Register **Terminal** type statically (`EvaluatesState` **off** in phase 1) at the composition root (§10 phase 1).

### IPC — DESIGN §6.5

- [x] Preload exposes only a typed **`window.octopusAPI`** via `contextBridge`; renderer never touches
  `ipcRenderer`/Node (DESIGN §5.5).
- [x] Request/reply commands via `ipcMain.handle` with renderer-generated `requestId`:
  `createTask{name,repoDir,sourceBranch,newBranch}`, `deleteTask{force?}`, `renameTask`, `reorderTask`,
  `createSession`, `closeSession`, `renameSession`, `reorderSession`, `writeToPty`, `resizePty`, `getState`,
  `updateSettings` (DESIGN §6.5). *(`createTask` input reworked to four fields.)*
- [x] **Directory-picker query** `dialog:pickDirectory` — stateless main-side `ipcMain.handle` returning an
  absolute path or `undefined` (native `dialog.showOpenDialog`, `['openDirectory','createDirectory']`); does
  **not** go through the command loop (like `getState`). Exposed as `octopusAPI.dialog.pickDirectory()` (DESIGN
  §5.4, §6.5). *(The one place Electron `dialog`/`BrowserWindow` is introduced.)*
- [x] Streaming `ptyData` via `webContents.send` (avoid head-of-line blocking) (DESIGN §6.5).
- [x] Backend→UI events: `ptyData`, `sessionCreated`, `sessionExited`, `sessionClosed`, `taskCreated`,
  `taskDeleted`, `taskRenamed`, `taskStale`, `scriptProgress`, `scriptError`, `error`; plus
  `sessionStateChanged`/`taskStateChanged` **defined but dormant** (DESIGN §6.5, §10 phase 1).
- [x] Keep message set transport-agnostic (phase 2 daemon can carry it over a Unix socket unchanged) (DESIGN §6.5).

### Concurrency & resilience — DESIGN §6.6

- [x] **Output batching / back-pressure** — per-session accumulator flushed on 16 ms (60 Hz) timer or at 256 KB
  cap (DESIGN §6.6).
- [x] **Inactive tabs** — append to a per-session ring buffer (~500 KB) and replay on tab activation (DESIGN §6.6, §5.3).
  *(Phase 1 realization is renderer-side in `pty/pty-router.ts`: keep-alive keeps every mounted pane's sink live, so
  the buffer covers the pre-mount / session-restore window where output would otherwise be lost. The backend
  "don't-send-to-inactive-tabs" optimization — a pure perf item, not user-visible — stays deferred to phase 2.)*
- [x] **Backend per-session ring buffer, persisted + replayed on restart** (DESIGN §6.6, §6.2 seam). *(Realizes
  the deferred backend ring buffer: `start-session-runtime.ts` taps every `onData` into a `ScrollbackBuffers`
  port — `RingBufferScrollbackStore` (adapter, reuses `session/ring-buffer.ts`, ~500 KB/session). Flushed to
  the `session_scrollback` table on quit (`quit.ts`, after `runtimes.clear()`, before checkpoint) and on
  spontaneous exit (`handle-runtime-exit.ts`, kept-tab), freed on user close (`close-session.ts`; DB row
  cascades). On restore, `start-task-sessions.ts` republishes the stored bytes as an ordinary `ptyData` event
  (history + a dim "session restored" separator) ahead of `sessionCreated`, so the existing renderer replay
  path shows prior scrollback above the fresh prompt — backend-only, no renderer/preload/shared change.
  Captured output is metadata, not live process state — compatible with I13.)*
- [ ] Phase 2+ note: spawn each shell via `setsid` (group-kill descendants) — *defer to phase 2* (DESIGN §6.1). *(Phase 1 uses
  SIGHUP/SIGKILL to the single PTY.)*

### UI (Renderer) — DESIGN §5

- [x] **Zustand store** — `tasks`, `sessions`, `activeTaskId`, `activeSessionId` (per task). **`ptyData` bypasses
  the store**, delivered by IPC directly to the target `TerminalPane` (DESIGN §5.2).
- [x] Startup hydration via `app:getState`; thereafter lifecycle events patch the store (DESIGN §5.2).
- [x] Component tree scaffold: `App → ProgressPanel + TaskWorkspace` (DESIGN §5.1).
- [x] **`ProgressPanel`** — `PanelHeader (NewTaskButton, DeleteTaskButton, settings gear)` + `TaskList → TaskListItem*`
  (label only in phase 1; `TaskStatusIcon` is phase 2) (DESIGN §5.1, PRD §Progress Window).
- [x] **`TaskWorkspace → TaskView*`** — one per task; **all mounted, only active visible** (DESIGN §5.1, §5.3).
- [x] **`SessionTabBar`** — `NewSessionDropdown` (registry-driven) + `SessionTab*` (no status icon in phase 1) (DESIGN §5.1).
- [x] **`SessionPaneArea → SessionPane*`** — `TerminalPane` (JenkinsPane is phase 3) (DESIGN §5.1).
- [x] **`TerminalPane`** — xterm.js instance created once in `useRef`/`useEffect([])`, never destroyed until
  session close (DESIGN §5.3).
- [x] xterm.js addons: `fit`, `webgl` (canvas fallback), `search`, `web-links`, `unicode11`, `serialize`;
  scrollback bounded ~10 000 lines (DESIGN §4, §5.3).
- [x] **Keep-alive on task switch (critical)** — hidden sessions use `visibility:hidden; position:absolute;
  width/height:0` (NOT `display:none`); `terminal.write` keeps running for hidden sessions (DESIGN §5.3).
- [x] On show: `fitAddon.fit()` → `pty:resize` → `terminal.refresh(0, rows-1)`; on hide: nothing (DESIGN §5.3).
- [x] **WebGL context scale mitigation** — a module-level lease pool (~15 contexts) in `terminal/webgl-budget.ts`;
  an active pane takes a WebGL lease, and when none is free it loads the Canvas renderer instead — hidden panes
  hold no lease (DESIGN §5.3).
- [x] Data flow wiring: keystroke `xterm onData → octopusAPI.pty.input → ipcMain → pty.write`; output
  `pty onData → batched → send('pty:data') → terminal.write` (DESIGN §5.2).
- [x] **New Task modal** — four fields: **name**, **repo directory** (read-only + "Browse…" calling
  `octopusAPI.dialog.pickDirectory()`), **source branch** (editable, `main` placeholder), **new branch**
  (prefilled with `taskNameToBranchSlug(name)` until the user edits it, e.g. `feature/add_feature_1`).
  Client-side validation gates "Create Task"; spinner while provisioning; on success task becomes
  active/empty; on failure inline red stderr block + Retry + toast (DESIGN §5.4, §12.3). Replaces the inline
  name input in `App.tsx`.
  - [x] **Third tab, "No Repo"** — name-only; creates a repo-less task (`repoLess: true`, no worktree)
    synchronously (no script/git, nothing on disk); its sessions open at the home directory with no `cd`.
    Grouped view lists repo-less tasks under a **"No Repository"** header after all repo groups (DESIGN §5.4,
    §6.1, §6.2). Persistence: `tasks.repo_less` column (schema v7); repo-less rows store `worktree = ''`.
- [x] **New Session dropdown** — populated from registry; Terminal creates immediately (a lone type skips the
  menu); double-click a tab renames it (DESIGN §5.4).
- [x] **Delete Task** — confirm dialog whose body reflects ownership (a managed worktree "closes all sessions
  and removes the worktree"; an adopted "From Existing Repo" task closes sessions but leaves the directory on
  disk; a "No Repo" task closes sessions with nothing removed from disk, §6.4); extra "uncommitted changes —
  delete anyway?" confirmation on dirty worktree; **Force-forget**
  for Stale/`provision_failed`/`delete_failed` tasks (DESIGN §5.4).
- [x] **Tabs UX** — horizontal scroll + chevrons on overflow; "…" overflow menu beyond ~8 tabs; drag-reorder via
  `@dnd-kit/core` (tasks and tabs); per-tab `×` close (DESIGN §5.4).
- [x] **Keyboard shortcuts** — `Ctrl+Shift+]`/`[` cycle tasks; `Ctrl+Shift+Tab` cycle sessions;
  `Ctrl+Shift+T` new terminal; `Ctrl+Shift+N` new task; `Ctrl+Shift+W` close session; `Ctrl+Shift+F` search.
  **Only Shift-modified shortcuts intercepted globally** so terminal `Ctrl+C` is never stolen (DESIGN §5.4).
  *(Note: `Ctrl+Tab` and `Ctrl+Shift+C/V` from the doc are intentionally omitted — they conflict with the
  Shift-only-intercept safety rule / browser reservations; documented inline in `useKeyboardShortcuts.ts`.
  `Esc`-to-close is owned by each modal component.)*
- [x] **Empty states & toasts** — "No tasks yet", "No sessions", inline "Connecting…"; bottom-right toasts for
  script failures / unexpected PTY exit (DESIGN §5.4).

### Phase 1 dormant seams (explicit — must exist, unused) — DESIGN §10 phase 1

- [x] `capabilities.EvaluatesState` present (Terminal **off**).
- [x] `SessionRuntime.stateEvaluator()` returns `null`.
- [x] `EventBus` carries state events (dormant).
- [x] Aggregator called but yields `Unknown`; UI renders **no icons**.
- [x] View resolution keyed by `typeId`.
- [x] `SessionConfig` validated against `configSchema`.
- [x] `OCTOPUS_STATE_SOCKET` env + per-session socket dir `/tmp/octopus-<uid>/` (`chmod 700`) **provisioned but
  unused** (DESIGN §9.2, §10 phase 1).
- [x] `CredentialsProvider` port shape defined.

### Phase 1 Testing — DESIGN §11

- [x] Unit: aggregation combinations (all yield `Unknown` in phase 1), lifecycle state machines, invariants I1–I12.
- [x] Unit: path validation & delete safety-check logic (containment, sanity).
- [x] Unit: pure `worktree-path.ts` (`sanitizeBranchForDir`, flat `computeWorktreePath`); default-base resolver
  in `paths.test.ts`; `SelectingWorktreeProvider` probe dispatch (script present → script; absent → native);
  `NativeGitWorktreeProvider` argv/cwd/env, non-zero + timeout reject, safe-delete guard, `--force` on
  confirmed-dirty (fake `ScriptRunner`); `ScriptWorktreeProvider` repo-local contract; SQLite v2 migration.
- [x] Integration: create/delete against a throwaway repo — both provisioning paths: a repo **with**
  `create_worktree.sh`/`delete_worktree.sh` (script contract) and a repo **without** (native `git worktree
  add`/`remove` under `worktree.location`); gated on `git` availability.
- [x] Integration: PTY spawn at correct cwd, resize, exit/scrollback retention.
- [x] Integration: restart reconciliation (worktree missing → `Stale`, no runtime; present → stays `Ready`,
  `switchTask` spawns a fresh shell at the worktree cwd) — `test/integration/reconcile.integration.test.ts`,
  real `existsDir` + real PTY stack.
- [x] E2E smoke: create task → open terminal → run command → switch task (buffer preserved) → delete task —
  headless over the real `CommandLoop`/PTY stack in `test/integration/smoke.integration.test.ts`.

---

## Phase 1.5 — Multi-Window

Goal: run Octopus across **multiple OS windows** (one per monitor). The **main** window owns the progress
panel; **secondary** windows are session-only. All windows sync on the single `activeTaskId` (switch a task →
sessions switch everywhere). A window may hold zero sessions; a session can be dragged into another window;
windows + assignments are restored on relaunch. **Strictly additive on phase 1** — no existing signature changes
(DESIGN §3.7, §5.6, §6.7, §10 phase 1.5, I18). User decisions: cross-window DnD = *detach + drop-on-window*;
secondary-window close with live sessions = *ask* (move-to-main vs kill); main-window close = *quit app*.

### Domain (pure) — DESIGN §3.7, §10 phase 1.5

- [x] `WindowId` branded id + `MAIN_WINDOW_ID` constant in `src/domain/ids.ts` (mirrors `TaskId`/`SessionId`).
- [x] `Session.windowId: WindowId` field (default `MAIN_WINDOW_ID`) + `assignToWindow(windowId)` mutation in
  `src/domain/session.ts`; `fromSnapshot` reads `snap.windowId ?? MAIN_WINDOW_ID`, `toSnapshot` emits it.
  **`taskId` never changes** on a move (I7, I18); no invariant/lifecycle change.
- [x] `windowId: WindowId` added to `SessionSnapshot` in `src/domain/snapshots.ts`.

### Application — DESIGN §6.7, §10 phase 1.5

- [x] New commands in `src/application/commands.ts` + `CommandLoop` cases (`src/application/command-loop.ts`):
  `createWindow{role:'secondary',bounds?}`, `closeWindow{windowId,disposition}`,
  `moveSessionToWindow{sessionId,targetWindowId}`, `createWindowWithSession{sessionId,bounds?}` (atomic
  create+move). Extend `CommandResult` with optional `windowId?`.
- [x] Use case `create-window.ts` — generate `WindowId`, persist `WindowRecord` (secondary), emit `windowCreated`.
- [x] Use case `close-window.ts` — `move-to-main` bulk-moves the window's sessions to main / `kill-sessions`
  closes each; delete the window record; emit `windowClosed`.
- [x] Use case `move-session-to-window.ts` — `session.assignToWindow`, `upsertSession`, emit
  `sessionMovedToWindow{sessionId,taskId,fromWindowId,toWindowId}`. **No** `startTaskSessions` re-trigger
  (session is `Running`, not `Created` — PTY untouched, §6.7).
- [x] Use case `create-window-with-session.ts` — atomic: create secondary window then move the session;
  emit `windowCreated` then `sessionMovedToWindow` from one dispatch (avoids the two-round-trip drop race).
- [x] `src/application/queries/get-state.ts` — add `windows` + `thisWindowId` to `AppStateView`; sessions
  returned **unfiltered** (the renderer filters by `windowId`).

### Ports & Adapters — DESIGN §3.7, §6.3

- [x] `WorkspacePersistence` port (`src/ports/workspace-persistence.ts`) gains `loadWindows()` /
  `upsertWindow(record)` / `deleteWindow(id)` and a `WindowRecord {id, role, bounds, createdAt}` type.
- [x] `SqliteStore` (`src/adapters/persistence/sqlite-store.ts`) implements the three window methods; adds
  `window_id` to the `sessions` upsert.
- [x] Row mappers (`src/adapters/persistence/mappers.ts`) — `windowId` in session row mappers; add
  `windowToRow`/`rowToWindowRecord`.
- [x] **Schema v3→4 migration** (`src/adapters/persistence/schema.ts`) — bump `SCHEMA_VERSION` to 4; add
  `windows` table + `window_id` column to `SCHEMA_STATEMENTS`; `MIGRATIONS` entry `{toVersion:4}` with a
  guarded `ALTER TABLE sessions ADD COLUMN window_id TEXT NOT NULL DEFAULT 'main'`, `CREATE TABLE IF NOT
  EXISTS windows`, and `INSERT OR IGNORE` seeding the `main` window (same proven fresh-`CREATE`-plus-guarded-
  upgrade pattern as v2/v3).

### Infra / IPC (shared + main) — DESIGN §5.6, §6.7

- [x] `src/shared/ipc.ts` — CHANNELS `windowCreate`/`windowClose`/`sessionMove`/`windowAtPoint`; `windows`
  group on `OctopusAPI` (`create`/`close`/`windowAtPoint`), `sessions.move`, and synchronous
  `app.getWindowId()` (reads the `?windowId=` URL param — no IPC).
- [x] `src/shared/dto.ts` — `WindowDTO`, `WindowedWorkspaceStateDTO` (adds `thisWindowId`/`thisWindowRole`/
  `windows`), `MoveSessionInput`/`CreateWindowInput`/`CloseWindowInput`; `windowId` on `SessionDTO`.
- [x] `src/shared/events.ts` — `windowCreated`, `windowClosed`, `sessionMovedToWindow`; add to `EventDTO` union.
- [x] `src/preload/index.ts` — implement the `windows` group, `sessions.move`, and `app.getWindowId()`.
- [x] **`src/main/window-registry.ts`** (new, replaces `event-forwarder.ts`) — `Map<WindowId,{webContents,
  ready,pending[]}>`, one bus subscription; routing rules (§6.7): `ptyData`/session-scoped → hosting window;
  `sessionMovedToWindow` → both source & target; task-level/broadcast → all windows. Per-window `markReady`.
- [x] `src/main/window.ts` — `createWindow` gains `windowId`/`bounds`/`role`; inject `?windowId=` URL param;
  register/deregister with the registry; debounced bounds-save on move/resize; secondary `close` → dialog
  (move-to-main / kill / cancel) unless `isQuitting`; main `close` → `app.quit()`.
- [x] `src/main/ipc-handlers.ts` — handlers for `windowCreate`/`windowClose`/`sessionMove`/
  `createWindowWithSession`; `windowAtPoint` hit-test over `BrowserWindow.getAllWindows()` bounds (query,
  bypasses the loop); `appGetState` returns `WindowedWorkspaceStateDTO` and marks the calling window ready.
- [x] `src/main/composition-root.ts` — `loadWindows()` on startup; seed main window record; build the
  `WindowRegistry`; create secondary `BrowserWindow`s at persisted bounds with **off-screen clamping**;
  update `AppContext`.
- [x] `src/main/index.ts` — drop `window-all-closed → quit`; create all persisted windows on `whenReady`
  (main first); `isQuitting` flag set in `before-quit`.

### UI (Renderer) — DESIGN §5.6

- [x] `src/renderer/src/store/store.ts` — add `windowId`/`windowRole`/`windows` to `StoreData`; hydrate from
  `WindowedWorkspaceStateDTO`; `reduceEvent` cases for `windowCreated`/`windowClosed`/`sessionMovedToWindow`;
  update `initialData()`.
- [x] `src/renderer/src/App.tsx` — branch on `windowRole`: `MainWindowApp` (existing layout) vs
  `SecondaryWindowApp` (no `ProgressPanel`).
- [x] `src/renderer/src/components/SecondaryWorkspace.tsx` (new) — render sessions of the active task where
  `session.windowId === thisWindowId`; identical keep-alive/visibility logic to `TaskView` (§5.3).
- [x] `src/renderer/src/components/ProgressPanel.tsx` — add a **New Window** button (→ `windows.create`).
- [x] `src/renderer/src/components/SessionTabBar.tsx` — cross-window **detach** gesture: pointer leaves the
  bar by ~20 px → cancel dnd-kit → on `pointerup` read `screenX/screenY` → `windows.windowAtPoint` →
  `sessions.move` (hit a window) or `createWindowWithSession` (empty desktop).
- [x] No change needed: `src/renderer/src/pty/pty-router.ts` and `src/renderer/src/terminal/webgl-budget.ts`
  — their module-level singletons are already per-renderer-process, so correct per window (§5.6). Confirmed.

### Phase 1.5 Testing — DESIGN §11

- [x] Unit: schema **v3→4** migration (`sqlite-store.test.ts`, `FakeDb`) — `window_id` ALTER, `windows` table
  created, main window seeded; guarded so it fires only from a v3 DB. *(Real better-sqlite3 can't load under
  host Node — built for Electron's ABI — so the migration wiring is exercised via the scriptable `FakeDb`,
  the same substitute the rest of the store suite uses.)*
- [x] Unit: use cases — `create-window`, `close-window` (both dispositions), `move-session-to-window`
  (asserts `taskId`/lifecycle unchanged, I18), `create-window-with-session`.
- [x] Unit: `WindowRegistry` routing — `ptyData`/session events → hosting window only; `sessionMovedToWindow`
  → both windows; task-level/broadcast → all windows.
- [x] Unit: store `reduceEvent` for the three new events + `sessionIdsInWindow`/`activeSessionInWindow`
  projection; `SecondaryWorkspace` window filtering + empty-state; off-screen clamping (`window-bounds.test.ts`).
  *(`windowAtPoint` hit-test is inline in the Electron handler over `BrowserWindow.getAllWindows()` — not a
  pure helper, so it is left to manual verification with the rest of the multi-window UI.)*
- [ ] Integration: secondary-window close dispositions (move-to-main keeps PTYs alive; kill closes them);
  `isQuitting` suppresses the dialog during app quit. *(Needs a real Electron display — manual for now.)*
- [ ] Integration: restart restores windows + session→window assignments; a session whose window is gone
  falls back to `MAIN_WINDOW_ID` (I18). *(Needs a real Electron display — manual for now.)*

---

## Phase 2 — Session State + Aggregation + Icons

Goal (PRD §Phases Phase 2): session-state evaluation/display, task state derived from sessions, status icons in
progress window and tabs. **The domain and UI share ONE vocabulary: `Unknown`/`Idle`/`Working`/`NeedsInput`**
(enum member names; values stay the wire strings `'waiting'`/`'blocked'`, DESIGN §3.3). **Status is Claude-only**
(§9): a program that reports its own state (Claude via its hooks) drives the icon; a bare terminal is always
`Unknown`. Per-program mapping is a **pluggable detector registry** (Claude ships in phase 2). **No new ports,
no domain signature changes** (DESIGN §10 phase 2).

> **Load-bearing backend fact (DESIGN §9.6):** the default `terminal.backend` is `octopusd`, and the **PTY
> master fd lives inside the daemon**. So `tcgetpgrp` / `/proc/<pgid>/comm` / OSC-parsing **run inside
> `octopusd`** for the daemon backend and inside Electron main for `in-process`. Both surface state through
> the one unchanged `SessionRuntime.stateEvaluator()` seam; the daemon ships it as a new protocol `CONTROL`
> message. Design detectors as backend-agnostic (fed a byte stream + an fd), and host them per backend.

### State-detection subsystem — DESIGN §9

- [x] `StateProvider` interface — `initialize(ctx)`, `poll()`, `get_state() → StateSnapshot{state, confidence,
  assessed_at, reason, layer}`, `teardown()`; confidence ∈ {Authoritative, High, Medium, Low, None} (DESIGN §9.3).
  Replaces the phase-1 `type StateEvaluator = unknown` placeholder in `src/ports/session-runtime.ts` (fill the
  seam; keep `stateEvaluator(): StateEvaluator | null` signature). *(Realized as the backend-neutral
  `CoreStateEvaluator` in `src/shared/node/state/state-core.ts` + the ports `StateEvaluator`.)*
- [x] **Structural sentinel** (the only structural signal, DESIGN §9.1): "is the shell at its own prompt?"
  - [x] OSC 133 semantic prompt marks (A/B prompt, C command-start, D;exit) refine the at-prompt read (DESIGN §9.1).
  - [x] `tcgetpgrp(master_fd)` vs shell PGID (shell foreground = at prompt; child = running); polled 200 ms
    (DESIGN §9.1, §9.3). Shell at prompt ⇒ tracked program gone ⇒ `Unknown` (clears the stored explicit).
  - [x] O(1)/byte OSC parser reusing a hardened parser (xterm.js's); cap param length 1 KB + sequence timeout;
    never propagate parse errors to renderer (R6).
  - [x] No Layer-1 activity timing and no silence-based `Blocked` heuristic — **removed** (they caused the
    flapping bug); a foreground program with no explicit signal stays `Unknown` (DESIGN §9.1, §9.3).
- [x] **`ProgramStateDetectorRegistry`** (pluggable per-program mapping, DESIGN §9.3) — `ProgramStateDetector`
  = `matches(comm): boolean` + `interpret(signal): CoreState | undefined`; keyed off the foreground `comm`
  (`/proc/<pgid>/comm`). Registered at the **composition root** (like the session-type registry, §8). Phase 2
  registers exactly one entry (Claude) + a default that trusts the signal verbatim. Consulted per explicit signal.
- [x] **`ClaudeCodeDetector`** (Layer 3, authoritative — the source of `NeedsInput`) registered for
  `comm == claude` (DESIGN §9.2):
  - [x] Per-session Unix socket `/tmp/octopus-<uid>/session-<uuid>.sock` (dir `chmod 700`); export
    `OCTOPUS_STATE_SOCKET`; async listen (activate the phase 1 seam — `socket-provisioner.ts`). **For the
    daemon backend the socket is exported + listened on inside `octopusd`** (it spawns the PTY, §9.6, §6.2).
  - [x] Message validation — ≤1 KB, valid JSON, known state values; **nothing from a message is ever executed** (R5).
  - [x] Graceful degradation — socket unset/gone / `nc` absent → guarded `|| true` no-op; session stays `Unknown`.
  - [x] OSC 9000 in-band state escape sequence support (DESIGN §9.1).
- [x] **`CompositeStateProvider`** — fuses the structural sentinel + the registry-remapped explicit signal per
  the §9.1 Claude-only ladder:
  - [x] No `/proc` → `Unknown`; shell at prompt → `Unknown` (clear explicit); child + stored explicit →
    report it verbatim (never stale while a child runs); child + no explicit yet → `Unknown`.
  - [x] Explicit signals are **sticky** across poll ticks — no staleness window, no `T_explicit`/`T_stale`
    (the flapping-bug fix, DESIGN §9.1).
- [x] **Internal sub-states** wired to confidence scoring (not UI): `Waiting/AtPrompt`, `Waiting/Explicit`,
  `Working/Explicit`, `Blocked/Permission`, `Blocked/Explicit`, `Initializing`→Working (DESIGN §3.3, §9).
  *(Enum `SessionSubState` — `src/domain/state.ts`.)*
- [x] **No debounce/hysteresis** — explicit transitions are event-driven (already debounced by discrete hook
  events) and emit immediately; the only poll-driven transition is to/from `Unknown` on the at-prompt sentinel,
  also immediate so the icon clears the instant Claude exits (DESIGN §9.3).

### Daemon-hosted detection + protocol (daemon backend, the default) — DESIGN §9.6, §6.2

- [x] Host the `CompositeStateProvider` **inside `octopusd`** alongside `DaemonPty` — it taps the existing
  output batcher for OSC/activity and holds the fd for `tcgetpgrp` (`src/daemon/daemon-pty.ts` /
  `pty-registry.ts`). Export + listen on `OCTOPUS_STATE_SOCKET` daemon-side.
- [x] Additive **`CONTROL` message** `{type:'state', sessionId, state, subState?, confidence, reason, layer}`
  daemon→app on the existing length-prefixed protocol (`src/shared/node/daemon-protocol.ts`) — **not** a `DATA`
  frame (keeps the <5 ms terminal byte path untouched, §11).
- [x] Additive **client→daemon `refreshState{sessionId}`** control for the manual "refresh state" affordance (R1).
- [x] `DaemonSessionRuntime.stateEvaluator()` returns an adapter surfacing those `state` messages; app-side
  ingest re-emits them as the same `sessionStateChanged` `EventBus` event (backend-agnostic ingest).
- [x] In-process backend (`PtyTerminalRuntime.stateEvaluator()`) runs the same composite in Electron main and
  emits `sessionStateChanged` directly. Daemon-launch-failure fallback → in-process path (DESIGN §6.2).

### Auto-injection (opt-out) — DESIGN §12.1

- [x] Inject **OSC 133 shell integration** into Octopus's own terminals via `--rcfile`/profile snippet that
  **sources the user's own rc first** (never edits `~/.bashrc`) (DESIGN §9.1, §12.1). *(`shell-integration.ts`.)*
- [x] Write Claude Code hooks into the user-global `~/.claude/settings.json`, **merging with — never
  clobbering —** an existing file (DESIGN §9.2, §12.1): *(`src/adapters/claude/claude-hooks.ts`.)*
  - `Stop` → `{"state":"waiting","reason":"claude_stop"}` (Idle)
  - `Notification` → `{"state":"blocked","reason":"notification"}` (NeedsInput — Claude's real attention event)
  - `PreToolUse` / `PostToolUse` / `UserPromptSubmit` → `{"state":"working",…}`
  - hook one-liner uses `nc -N -q0 -w1 -U` so the `Stop` hook returns in ms (OpenBSD `nc` otherwise lingers ~2 min).
- [x] Provide an opt-out setting for auto-injection. *(`terminal.stateDetection` / `terminal.injectClaudeHooks`.)*

### Application / Domain wiring — DESIGN §10 phase 2

- [x] Flip Terminal's **`capabilities.EvaluatesState` on** (`terminal-session-type-provider.ts`, currently
  `new Set()`); `SessionRuntime.stateEvaluator()` now returns the composite provider (both runtimes).
- [x] Runtime emits **`sessionStateChanged`** on the `EventBus` (push-based); Application ingests it via the
  **existing** single-writer loop `ingestSessionState` case (`command-loop.ts:127` — dispatched by nobody in
  phase 1) (DESIGN §8, §6.6). *(The command + input type already exist — `commands.ts`.)*
- [x] Add `Session.setState()` mutation (does **not** exist yet — phase 1 `_state` is never mutated) so
  `ingestSessionState` can apply the new state; recompute derived `TaskState` (I11).
- [x] `TaskStateAggregator` (`worstStatusWins`, already wired) now produces real aggregate states; recompute
  on session add/remove and on each ingested `sessionStateChanged` (pure `max` → cannot drift) (I11, §3.4).
- [x] `Exited`/`StartFailed` session maps to `NeedsInput` for aggregation; no-`EvaluatesState` session →
  `Unknown` and transparent unless sole signal (I12). *(Also mirrored renderer-side: the store recomputes
  task `state` worst-wins on each `sessionStateChanged` so the task icon never lags a session — bug 2.1.)*
- [x] Emit `taskStateChanged` view-model events to the renderer (`WindowRegistry` broadcasts to all windows,
  §6.7).
- [ ] *(Optional infra)* Spawn shells via `setsid` so group SIGKILL kills descendants (DESIGN §6.1).
  *(Deferred — not required for Phase 2; the OS still reaps the single PTY child on quit.)*

### UI — DESIGN §5.4, §9.5, §10 phase 2

- [x] **`SessionStatusIcon`** in `SessionTab` (after the title label — `SessionTab.tsx`) and **`TaskStatusIcon`**
  in `TaskListItem` (before the lifecycle suffix — `TaskListItem.tsx`) (DESIGN §5.1). *(`StatusIcon.tsx`.)*
- [x] Icon design — shared vocabulary **Idle/Working/NeedsInput** (§3.3); shape **and** color: **Idle** =
  hollow/pause, gray; **Working** = spinner/filled, blue; **NeedsInput** = warning triangle, amber;
  **Unknown** = no icon; tooltips = label + reason (DESIGN §5.4). *(Inline SVG in `StatusIcon.tsx`.)*
- [x] Zustand: session `state` already lands via the `reduceEvent` `sessionStateChanged`/`taskStateChanged`
  cases (they patch `sessions[id].state`/`tasks[id].state` today) — add a derived `taskStatuses` selector
  applying §3.4 for rendering. No new event plumbing (DESIGN §5.2).
- [x] **Ready-for-review** (DESIGN §9.5) — renderer view-model only: `readyForReview` map + `taskReadyForReview`
  selector; **raise** on a `Working→Idle` `sessionStateChanged` for an **unfocused** session (not
  `NeedsInput→Idle`, not a cold `Idle`); **clear** on focusing that session. Render a **green check** icon
  variant in place of the plain idle icon. Not persisted, not in any DTO, no backend change.
- [x] Manual **"refresh state"** affordance → `refreshState{sessionId}` (daemon) / re-poll (in-process) (R1).
- [x] App-quit warning becomes meaningful: warn on quit if any session Working/NeedsInput (I13).
  *(`confirmQuitWhileBusy` in `src/main/window.ts`, backed by the `busySessions` query.)*

### Observability — DESIGN §11

- [x] Structured JSON **state-transition log** at `~/.local/share/octopus/state.log` (every transition w/
  layer + confidence + reason) (R1, DESIGN §11). *(`state-log-file.ts`.)*
- [x] Keyboard-toggled **debug overlay** showing last N transitions per session (source layer + reason).
  *(`DebugOverlay.tsx`, Ctrl+Shift+D.)*

### Optional Phase 2 infra (only if process-survival prioritized) — DESIGN §6.2, §12.2

- [x] `DaemonSessionManager` (or tmux backend) behind the existing `SessionManager` port — server-side ring
  buffer (~5 MB/session) replayed on re-attach; **renderer unaffected** (DESIGN §6.2).
  *(`daemon-session-manager.ts` + `octopusd`; the default backend, gated by `terminal.backend`.)*

### Phase 2 Testing — DESIGN §11

- [x] Unit: OSC parser byte-sequences; §9.1 Claude-only decision ladder; explicit signals sticky across poll
  ticks + cleared at prompt (the flapping-bug regression, 2.2). *(`osc-parser.test.ts`, `state-composite.test.ts`.)*
- [x] Unit: `ProgramStateDetectorRegistry` dispatch — `comm == claude` → Claude detector; unknown → default
  (verbatim signal); a program with no explicit signal stays `Unknown` (DESIGN §9.3). *(`state-core.test.ts`.)*
- [x] Unit: **ready-for-review** store logic (§9.5) — `Working→Idle` on unfocused raises; `NeedsInput→Idle`
  and cold `Idle` do not; focus clears; `taskReadyForReview` = OR over sessions; not restored after reload.
  Plus task-state worst-wins recompute on `sessionStateChanged` (bug 2.1). *(`store.test.ts`.)*
- [x] Unit: daemon `state` `CONTROL` frame encode/decode round-trip; `DaemonSessionRuntime` surfaces it as
  `sessionStateChanged` (DESIGN §9.6). *(`daemon-protocol.test.ts`, `daemon-session-runtime.test.ts`.)*
- [x] Integration: a plain foreground child (`sleep`) with no explicit signal stays `Unknown` (Claude-only).
  *(`session-state.integration.test.ts` — real PTY.)*
- [x] Integration: a socket write while a child holds the foreground → `NeedsInput`, sticky across ticks,
  cleared to `Unknown` at the prompt. *(`session-state.integration.test.ts`.)*
- [ ] E2E: real Claude Code with hooks → assert Working/NeedsInput; a finished agent shows the ready-for-review
  highlight until its tab is focused. *(Manual — needs a real Claude Code process + display.)*
- [ ] Failure injection: socket disconnect / `nc` absent → session stays `Unknown` (no misfire); daemon-launch
  failure → in-process detection still emits state (DESIGN §6.2, §9.6). *(Fallback paths covered at the unit
  level — the no-`/proc`/no-explicit branches in `state-composite.test.ts`, daemon-launch fallback in the
  switchable manager; a dedicated end-to-end injection harness is deferred.)*
- [ ] Perf targets: OSC 133→state <10 ms; hook→state <20 ms; state→task icon <50 ms; Claude-exit→icon-clear
  ≤200 ms; state subsystem <1 MB/session (DESIGN §11). *(Manual — needs an instrumented run on target hardware.)*

---

## Phase 3 — Jenkins Pipeline Viewer

Goal (PRD §Phases Phase 3): new session type connecting to Jenkins, showing pipeline progression, reporting
state back to the task. **Zero changes** to Domain, Application use cases, Terminal, or the aggregator
(DESIGN §8 acceptance test, §10 phase 3).

### Ports & Adapters — DESIGN §9.4, §10 phase 3

- [ ] `JenkinsClient` port + **`JenkinsHttpClient`** adapter (DESIGN §10 phase 3).
- [ ] Auth via **`CredentialsProvider`/OS keychain (libsecret)** — never plaintext; resolve `credentialsRef` at
  runtime (I16, R5).
- [ ] `JenkinsProvider` state mapping (poll `<job>/lastBuild/api/json` every ~10 s, configurable) (DESIGN §9.4):
  - `building==true` → **Working**
  - `SUCCESS/UNSTABLE/FAILURE/ABORTED/NOT_BUILT` → **Waiting** (failed pipeline isn't *asking* Octopus → not Blocked)
  - Input step `PAUSED_PENDING_INPUT` (via `/wfapi/describe`) → **Blocked**
  - Never `Unknown` after first successful poll.

### Session type registration — DESIGN §8, §10 phase 3

- [ ] `JenkinsSessionTypeProvider` — `EvaluatesState` on; `configSchema` = `{ jobPath, branch (defaults to
  worktree branch), credentialsRef }` (DESIGN §3.2, §8).
- [ ] `JenkinsViewFactory` (UI) keyed by `typeId`.
- [ ] Register at composition root — dropdown (filtered by `availableFromVersion`) and aggregation pick it up
  automatically (DESIGN §8).

### UI — DESIGN §5.1, §5.4

- [ ] `JenkinsPane` `SessionPane` rendering pipeline progression for the task's branch.
- [ ] New-Session flow: Jenkins opens a small **config modal** (job/branch/creds) (DESIGN §5.4).
- [ ] Jenkins-error toasts (DESIGN §5.4).

### Phase 3 acceptance / testing — DESIGN §8, §11

- [ ] **Abstraction acceptance test**: adding Jenkins required **zero edits** to `Task`, the aggregator, or the
  dropdown logic (DESIGN §8). If any were needed, the phase 1 abstraction was wrong — fix upstream.
- [ ] Integration: mocked Jenkins API responses → assert Working/Waiting/Blocked mapping (§9.4).
- [ ] Integration: keychain-backed credential resolution; assert no secret ever persisted to DB/JSON (I16).
- [ ] Perf: Jenkins poll cadence 10 s honored/configurable (DESIGN §11).

---

## Split Panes (Split Groups) — DESIGN §5.7

Plan: `docs/plans/split-groups_2026-10-13-plan.md`. Supersedes the earlier, unshipped
`docs/plans/split-panes_2026-10-12-plan.md` renderer-owned-per-window-layout design: groups are backend-owned
on the `Task` aggregate instead.

### Domain / Shared / Persistence / Application — DESIGN §5.7, §3.1, §6.3

- [x] `src/domain/group-tree.ts` (new) — pure `GroupTree` ops: `leaf`, `leafIds`, `hasLeaf`, `split`,
  `removeLeaf` (returns `undefined` to signal dissolve), `setRatio`, `validate` (sanitizes untrusted saved
  JSON: dedupes/clamps/collapses, requires ≥2 leaves).
- [x] `src/domain/task.ts` — `Group {id, tree, colorIndex}`, `GROUP_COLOR_PALETTE_SIZE = 6`, `_groups`;
  `join`/`leave`/`ungroup`/`reorderGroup`/`resizeGroup`; `groups()`/`groupOf()`/`groupMembers()`;
  `fromSnapshot` → `restoreGroups` drops any saved group that fails its invariants (bad tree, unknown/
  duplicate/too-few/cross-window/non-contiguous leaves); `toSnapshot()` emits `groups`.
- [x] `src/shared/dto.ts` — `TaskDTO.groups: readonly GroupDTO[]`, `GroupDTO {id, layout: SplitNode,
  colorIndex}`, `SplitNode`/`SplitPath`, `CreateSessionInput.split?: {anchorSessionId, dir}`,
  `JoinGroupInput`/`LeaveGroupInput`/`UngroupInput`/`ReorderGroupInput`/`ResizeGroupInput`; six chord settings
  (`splitRightKey`, `splitDownKey`, `focusPane{Left,Right,Up,Down}Key`) threaded through settings store,
  defaults and mapper.
- [x] `src/shared/events.ts` — `groupsChanged{taskId, groups}` (full-list replace); `sessionMovedToWindow.cause?:
  'windowClosed' | 'groupMove'`.
- [x] `src/shared/ipc.ts` / `src/main/ipc-handlers.ts` — `group:join|leave|ungroup|reorder|resize` channels,
  `OctopusAPI.groups.{join,leave,ungroup,reorder,resize}`, defensive-validated handlers.
- [x] Schema **v9** (after the Issues v8): `session_groups` (id PK, task → tasks cascade, opaque JSON
  `layout`, `color` index); the v9 migration also drops the unshipped `split_layouts` table and re-creates
  `issues` if missing, healing dev DBs a split-pane build had stamped v8.
- [x] Use cases `join-group.ts` / `leave-group.ts` / `ungroup.ts` / `reorder-group.ts` / `resize-group.ts` +
  shared `persist-groups.ts` helper (diffs before/after group lists into `upsertGroup`/`deleteGroup`); join/leave
  also publish `sessionReordered`.
- [x] `open-session.ts` — atomic `input.split` (validated before mutation, degrades silently to a lone create
  on a losing race); `move-session-to-window.ts` / `close-window.ts` — whole-group move via `groupMembers`,
  `cause: 'groupMove'` for every riding-along member; `close-session.ts` — persists `groupsChanged` only when
  the closed session was grouped.
- [x] `window-registry.ts` — `groupsChanged` is not session-scoped, so it broadcasts to every window like other
  task-level events.

### UI (Renderer) — DESIGN §5.7, §5.3

- [x] `src/renderer/src/store/split-layout.ts` — now **geometry-only**: `toRects`, `splitHandles`, `neighbor`,
  `canSplit`, `setRatio` (local-preview-only, silent no-op), `leafIds`, `hasLeaf`; no mutation functions (the
  tree is backend-owned).
- [x] `src/renderer/src/store/store.ts` — `groupsByTask`, `groupOfSession`, `visiblePaneIds` (what-a-window-shows
  selector); `withMark` is a plain mark-setter; `sessionMovedToWindow` reducer honors `cause`.
- [x] `TerminalPane` — `active` split into `visible` + `focused`; key guard drops the six chords;
  `terminal-metrics.ts` for `canSplit`.
- [x] `SessionPane` / `TaskView` flat rect render keyed by session id, `showGroup` transient-state fallback;
  `SplitDividers` (sibling-after-panes drag gutters: local rAF-throttled preview, one `groups.resize` on
  release, preview clears on tree-identity-change not pointer-up).
- [x] Tab bar (`SessionTabBar.tsx`): per-group colored line (bridged across gaps), line-as-drag-handle
  (`startGroupDrag`/`finishGroupDrag` manual pointer-capture, dnd-kit can't share one id across tabs),
  `clampToGroupSpan`/`snapInsertionIndex` renderer-duplicated member-drag-limit/lone-snap-to-edge rules,
  `evaluateSplitMenu` enablement; tab menu Split right / Split down / Remove from group; group context menu
  Ungroup.
- [x] `tokens.ts` — `GROUP_COLOR_PALETTE` (6 colors, visually distinct from status-icon colors).
- [x] Shortcuts (`useKeyboardShortcuts.ts`): split chords send an atomic `sessions.create({split})`; directional
  focus chords move the mark among the shown group's leaves via `neighbor`; Settings fields.

### Split Panes Testing — DESIGN §5.7

> **Not done.** Verified by running `npm run test`: the groups implementation (Domain/Shared/Persistence/
> Application and UI sections above) has **no test coverage of its own** anywhere in the repo — no
> `group-tree.test.ts`, no group assertions in `task.test.ts`, no `*-group.test.ts` for any of the five use
> cases, no `session_groups` coverage in `sqlite-store.test.ts`, no group assertions in `store.test.ts` /
> `SessionTabBar.test.tsx` / `dto-mappers.test.ts` (their only "group" hits are the unrelated
> `groupTasksByRepo` sidebar setting). Worse, the test suite still contains the **old, unshipped** split-panes
> (v1) tests, now stale against the current API and **failing**: `npm run test` currently reports **154
> failing tests across 10 files** — `split-layout.test.ts` (53 failures: imports `prune`/`split`/`remove`/
> `siblingOf`/`replace`/`leaf`/`parseLayout`/`serializeLayout`, none of which `split-layout.ts` exports
> anymore), `sqlite-store.test.ts` / `command-loop.test.ts` / `dto-mappers.test.ts` (`split_layouts`/
> `saveSplitLayout`/`splitLayouts` DTO field, all removed), `SessionTabBar.test.tsx` / `SessionTab.test.tsx` /
> `SplitDividers.test.tsx` / `TaskView.test.tsx` / `useKeyboardShortcuts.test.tsx` (`closePane`, `splitWith`,
> `pendingSplit`/`cancelSplit`, `setSplitRatio`, all removed). The plan's own `## Testing` checklist
> (`docs/plans/split-groups_2026-10-13-plan.md`) already lists this work as entirely unstarted (`[ ]`
> throughout) — this subsection mirrors that, rather than the Subject 1–11 implementation items above, which
> are genuinely done.
- [ ] Unit: `group-tree.test.ts` (new); `task.test.ts` group invariants (join/leave/dissolve/ungroup/reorder/
  resize, tolerant `fromSnapshot`); each group use case (new); `sqlite-store` v9 `session_groups` CRUD/cascade.
- [ ] Never-remount test: joining, leaving, ungrouping, resizing and switching the mark between a group and a
  lone session keep the same xterm instance.
- [ ] Tab bar group-line/drag, shortcuts and Settings tests; edge cases (dissolve-at-1, cross-window move
  dragging the whole group, window-close keeping groups intact).
- [ ] Delete or rewrite the stale v1 split-panes tests listed above so `npm run test` passes again.
- [ ] Manual: DOM-renderer cost on the VDI host with four visible panes.

---

## Cross-Cutting Checklist (all phases) — DESIGN §7, §11

- [ ] **Invariants I1–I17** upheld and unit-tested where applicable (DESIGN §7).
- [ ] **Trust boundary** — user scripts & terminal commands run via `ScriptRunner`: explicit cwd, no
  shell-string interpolation, timeouts, captured exit/stderr (I17, R3).
- [ ] **Never persist secrets** — keychain-only via `credentialsRef` (I16, R5).
- [ ] **Air-gapped** — all deps vendored; no runtime network access outside Jenkins polling (DESIGN §4).
- [ ] **Performance targets** (DESIGN §11): PTY read→render <5 ms; state timings per phase 2; icon latency per phase 2.
- [ ] **Risk mitigations R1–R7** tracked (DESIGN §11).

---

## Issues — orthogonal feature (DESIGN §13)

Goal (PRD §Issues): a locally-stored work item (name, markdown description, optional project, 4-state
status), optionally bound 1:1 to a task, managed from a drawer that slides in over the main window's
session area. **Not gated by `CURRENT_VERSION`** and strictly additive — no change to `Task`, `Session`,
the state lattice, or the aggregator (DESIGN §10, §13). New invariant **I19** (DESIGN §7, §13.1): the
binding is 1:1 and stored only on the issue; any bind moves `todo → in_progress`; unbind never changes
status.

### Domain (pure) — DESIGN §13.1

- [ ] `src/domain/ids.ts`: branded `IssueId` + `asIssueId`.
- [ ] New `src/domain/issue.ts`: `IssueStatus` enum (`todo`/`in_progress`/`in_review`/`done`); `Issue`
  aggregate (`create`/`fromSnapshot`/`rename`/`setDescription`/`setProject`/`setStatus`/`touch`/
  `toSnapshot`); binding fields changed only through `Workspace`.
- [ ] `src/domain/snapshots.ts`: `IssueSnapshot`; optional `issues?` on `WorkspaceSnapshot` (back-compat
  with existing fixtures).
- [ ] `src/domain/workspace.ts`, issues collection: `issues()`, `issue(id)`, `addIssue`, `removeIssue`,
  `issueForTask(taskId)`.
- [ ] `src/domain/workspace.ts`, binding (**I19**): `bindIssue(issueId, taskId)` — reject a task already
  bound to a different issue; silently replace this issue's prior binding; `todo → in_progress` only from
  `todo`. `unbindIssue(issueId)` — status unchanged.
- [ ] `src/domain/workspace.ts`: `removeTask` clears the binding of any issue bound to it (status
  unchanged); `clearIssueProject(projectPath)` matches via `canonProjectPath`; `hydrate` drops bindings to
  tasks not present; `toSnapshot` emits `issues`.
- [ ] Tests: `src/domain/issue.test.ts` (validation, status set, snapshot round trip); extend
  `src/domain/workspace.test.ts` (reject double-bind, rebind replaces, todo→in_progress only from todo,
  unbind keeps status, removeTask unbinds, `clearIssueProject`, hydrate drops dangling bindings).

### Shared contract — DESIGN §13.3, §13.4

- [ ] `src/shared/dto.ts`: `IssueStatusDTO`, `IssueDTO`, `CreateIssueInput`, `UpdateIssueInput`,
  `DeleteIssueInput`, `BindIssueInput`, `UnbindIssueInput`, `OpenExternalInput`; `issueId?` on all three
  `CreateTask*Input` variants; `alsoDeleteIssue?` on `DeleteTaskInput`; `issues: readonly IssueDTO[]` on
  `WorkspaceStateDTO`; `issuesKey?` on `SettingsDTO`/`SettingsPatchDTO`; `issueId?` on `CommandAck`.
- [ ] `src/shared/events.ts`: `IssueUpsertedEventDTO`, `IssueDeletedEventDTO`, `IssuesDrawerToggleEventDTO`
  (synthesized in main, not a domain event); add all three to `EventDTO`.
- [ ] `src/shared/ipc.ts`: `CHANNELS.issueCreate/issueUpdate/issueDelete/issueBind/issueUnbind/
  shellOpenExternal` (request/reply); `issuesToggleDrawer` (fire-and-forget `send`); `OctopusAPI.issues`
  and `.shell.openExternal` groups.
- [ ] New `src/shared/external-url.ts`: pure `isSafeExternalUrl(url)` — `http:`/`https:` only, used by both
  main (validates) and renderer (filters).
- [ ] Tests: `src/shared/external-url.test.ts` (http, https, `javascript:`, `file:`, `mailto:`, relative,
  malformed, whitespace).

### Dependency

- [ ] `npm install --save-exact react-markdown@10.1.0 remark-gfm@4.0.1` via the Artifactory proxy; no
  `rehype-raw`. Confirm `npm run build` still bundles the ESM-only packages and the native-module
  `postinstall` still passes.

### Settings (backend side)

- [ ] `src/ports/settings-store.ts` + `src/adapters/settings/json-settings-store.ts`: `issuesKey?` on
  `Settings`/`SettingsPatch`, default `'Alt+Shift+KeyI'`.
- [ ] Test: extend `json-settings-store.test.ts` (default, patch, persistence).

### Persistence — schema v8 — DESIGN §13.2

- [ ] `src/ports/workspace-persistence.ts`: `upsertIssue(issue)`, `deleteIssue(id)`; `load()` returns
  `issues`.
- [ ] `src/ports/id-generator.ts` + `src/adapters/id/uuid-id-generator.ts`: `newIssueId()`.
- [ ] `src/adapters/persistence/schema.ts`: `SCHEMA_VERSION = 8`; `issues` DDL in `SCHEMA_STATEMENTS`
  (`task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL`); append-only `{ toVersion: 8 }` migration
  — never edit v1–v7.
- [ ] `src/adapters/persistence/mappers.ts`: `IssueRow`, `issueToRow`, `rowToIssueSnapshot`.
- [ ] `src/adapters/persistence/sqlite-store.ts`: `load()` reads `issues`; `upsertIssue` via
  `ON CONFLICT(id) DO UPDATE`; `deleteIssue`. **Keep `upsertTask` as `ON CONFLICT DO UPDATE` — never
  `INSERT OR REPLACE`**: `REPLACE` deletes the row, firing `ON DELETE SET NULL` and silently unbinding the
  issue (DESIGN §13.2).
- [ ] `src/application/use-cases/test-fakes.ts`: `FakePersistence` gains `upsertedIssues`, `deletedIssues`,
  a seeded `issues` map; its `deleteTask` mirrors `SET NULL`; the fake id generator gains `newIssueId()`.
- [ ] Tests: `mappers.test.ts` (issue row round trip, null project/task); `sqlite-store.test.ts` (`FakeDb`:
  `user_version` stamped 8, v8 migration runs from 7 and not on a fresh DB, `load` includes issues,
  upsert/delete SQL).
- [ ] `scripts/probe-sqlite-store.cjs` (`npm run probe:sqlite`, real binary): v7→v8 migration + backup hook;
  issue round trip; deleting a task sets `issues.task_id` NULL; a second issue on the same `task_id` raises
  the UNIQUE error; `upsertTask` on a bound task keeps `task_id`.

### Application — commands + domain events — DESIGN §13.3

- [ ] `src/ports/event-bus.ts`: `IssueUpsertedEvent`/`IssueDeletedEvent` on `DomainEvent`.
- [ ] `src/application/commands.ts`: `CreateIssueInput`/`UpdateIssueInput`/`DeleteIssueInput`/
  `BindIssueInput`/`UnbindIssueInput` (branded ids); `Command` union members `createIssue`/`updateIssue`/
  `deleteIssue`/`bindIssue`/`unbindIssue`; `issueId?` on `CreateTaskInput`; `alsoDeleteIssue?` on
  `DeleteTaskInput`; `issuesKey?` on `SettingsPatch`; `issueId?` on `CommandResult`.
- [ ] Use cases: `createTask(..., issueId?)` binds in the same transaction as the Ready task (not at
  Provisioning); a stale view (`issueId` already bound elsewhere or gone by the time the command reaches
  the front of the single-writer loop — not a race during the provisioning await, which the loop
  serializes) creates the task unbound with an error toast.
  `deleteTask(..., alsoDeleteIssue?)` applies the issue delete only in the final delete transaction — a
  dirty-gate cancel or delete failure leaves the issue untouched. `removeProject` clears `projectPath` on
  referencing issues.
- [ ] Tests: issue CRUD; bind rejected when the task is already bound; bind on Ready vs. failure vs.
  concurrent bind; delete-both only on success (incl. the uncommitted-changes cancel); project removal
  clearing issue projects.

### Renderer store + drawer view-state — DESIGN §13.5

- [ ] `src/renderer/src/store/store.ts`: `issues: Record<string, IssueDTO>` on `StoreData`/`initialData`;
  hydrate from `state.issues`; `reduceEvent` for `issueUpserted`/`issueDeleted` (clear `selectedIssueId` on
  delete of the selected issue) and `issuesDrawerToggle`; default `issuesKey: 'Alt+Shift+KeyI'`.
- [ ] `src/renderer/src/store/store.ts`, drawer view-state (**renderer-local, unpersisted**, survives
  settings re-hydrate): `issuesDrawerOpen`, `selectedIssueId`, `issueDraft`, `issueEditDirty`,
  `discardPrompt`; actions `toggleIssuesDrawer`/`openIssuesDrawer`/`selectIssue`/`startNewIssue`/
  `setIssueEditDirty`/`confirmDiscard`/`cancelDiscard`. While `issueEditDirty`, close/select/new raise
  `discardPrompt` instead of acting.
- [ ] Selectors `issueForTask(data, taskId)`, `isIssueBoundElsewhere`.
- [ ] New `src/renderer/src/store/group-issues.ts`: pure `groupIssuesByStatus(issues)` — fixed group order
  (Todo, In progress, In review, Done), newest first within each group.
- [ ] Tests: extend `store.test.ts` (hydrate issues; upsert/delete reducers; toggle/open/select; the dirty
  guard → discardPrompt → confirm/cancel; deleting the selected issue; re-hydrate keeps drawer state); new
  `group-issues.test.ts`.

### Preload bridge

- [ ] `src/preload/index.ts`: `issues.create/update/delete/bind/unbind` via `ipcRenderer.invoke`;
  `issues.toggleDrawer()` via `ipcRenderer.send`; `shell.openExternal(input)` via `invoke`.

### UI components — DESIGN §13.4, §13.5

- [ ] New `src/renderer/src/components/IssueStatusIcon.tsx`: inline SwiftShader-safe glyphs (○/◐/◉/✓), no
  icon library, no animation; exports `ISSUE_STATUS_LABELS`/`ISSUE_STATUS_ORDER`.
- [ ] New `src/renderer/src/components/IssueMarkdown.tsx`: `react-markdown` + `remark-gfm`, `skipHtml`;
  `components.a` calls `window.octopusAPI.shell.openExternal` only when `isSafeExternalUrl` passes; `img`
  renders as alt text.
- [ ] New `src/renderer/src/components/BoundDeleteDialog.tsx`: Delete task only / Delete issue only /
  Delete both / Cancel; Esc cancels; no backdrop blur or filter.
- [ ] New `src/renderer/src/components/DiscardChangesPrompt.tsx`: Discard / Keep editing.
- [ ] The Issues drawer itself (list + issue view split, **+ New Issue**, Edit/Save/Cancel, status
  dropdown, Delete/Create task/Link task/Unlink task) and its wiring into `ProgressPanel` (Issues
  button), the New-Task modal (Associated issue picker + prefill), the delete-task confirm (now
  `BoundDeleteDialog` when bound), and the task row icon (hover name, click opens drawer on that issue).
  Animates with a `transform` only — no blur/filter (VDI SwiftShader, DESIGN §13.5).
- [ ] `src/renderer/src/test-support/stub-bridge.ts`: `issues`/`shell` groups; `issues: []` in the default
  state.
- [ ] Tests: `IssueStatusIcon.test.tsx` (glyph + label per status); `IssueMarkdown.test.tsx` (GFM tables and
  task lists render; raw HTML does not; http/https links call `openExternal`; `javascript:`/`file:` do not
  and nothing navigates); `BoundDeleteDialog.test.tsx`; `DiscardChangesPrompt.test.tsx`.

### Issues Testing — DESIGN §13.6

- [ ] **Invariant I19** upheld and unit-tested (DESIGN §7, §13.1).
- [ ] Edge cases: `createTask(issueId)` dispatched with that issue already bound to a different task (or
  already deleted) — e.g. queue a `bindIssue`/`deleteIssue` ahead of it in the command loop, or seed the
  workspace with the issue already bound elsewhere before dispatching `createTask` — a stale-view case
  reachable because the loop only serializes commands from the moment each is dispatched, not from when
  the UI read the issue picker's list; delete-both then cancel at the uncommitted-changes step; Esc while
  editing; unsafe link schemes; rolling back to a pre-v8 build (`IncompatibleDbError`, `.bak-v7`).
- [ ] Existing-test updates: task create/delete, project removal, app state, SQLite store/mappers, command
  loop, New-Task modal, delete-task confirm, Progress panel, Settings, keyboard shortcuts, store, terminal
  pass-through.

---

## Issues Board (Kanban tab) — DESIGN §13.5

Plan: `docs/plans/kanban-board_2026-10-14-plan.md` (design: `docs/plans/kanban-board_2026-10-14-design.md`).
Goal (PRD §Issues → *Issues window* → *Board*): a Board tab in the Issues drawer — four status columns of
compact cards, drag a card to another column to change its status — sharing one selection with the List
tab under a unified drawer header. **Renderer only:** no new command, event, IPC channel, DTO field, schema
migration or npm dependency; a drop uses the existing `issues.update` status path.

### Renderer store — DESIGN §13.5

- [x] `src/renderer/src/store/store.ts`: `issuesDrawerTab: 'list' | 'board'` (`IssuesDrawerTab`) + action
  `setIssuesDrawerTab`; renderer view-state, never persisted, not in the hydrated projection, starts
  `'list'`, survives settings re-hydrate; `toggleIssuesDrawer`/`openIssuesDrawer(issueId)` keep the
  last-used tab.

### UI components — DESIGN §13.5

- [x] `IssuesDrawer.tsx`: header row with `role="tablist"` List/Board tabs and **+ New Issue** (moved out of
  `IssueList`, same guarded `startNewIssue`, works on both tabs). `IssueDetail` always mounted; only the
  List/Board pane is swapped, so a tab switch keeps the selection and unsaved edits with no discard prompt.
- [x] `IssueDetail.tsx`: fixed share of the drawer, `ISSUE_VIEW_WIDTH_SHARE = '61%'` /
  `ISSUE_VIEW_MIN_WIDTH = 360`, identical on both tabs; "Select an issue" placeholder at the same width.
  `IssueList.tsx`: the old `width: 660; maxWidth: 50%` sizing removed — the list fills the rest.
- [x] New `KanbanBoard.tsx`: four always-expanded columns from `groupIssuesByStatus` (newest first), header
  = status icon + label + count, per-column vertical scroll, `COLUMN_MIN_WIDTH = 220` with horizontal board
  scroll, "No issues" in an empty column (whose body still fills its height as a drop target).
- [x] New `KanbanCard.tsx`: two-line clamped name, project, linked-task chip; selected = list-row
  highlight; click → `selectIssue` (keeps the dirty guard). No shadow/blur/filter/animation.
- [x] Drag-and-drop (`KanbanBoard`/`KanbanCard`): manual pointer-capture drag modeled on `SplitDividers`/
  `SessionTabBar` — click/drag threshold; window-level `pointerup`/`pointercancel` fallback with an `ended`
  guard (Electron 33 has no `lostpointercapture`).
  - Drop on another column (empty space included) → `issues.update({ issueId, status })`, no prompts and no
    bind/task side effects; same column or outside → no call; the selection never changes.
  - Esc mid-drag cancels only the drag (window capture-phase `keydown`, ahead of the drawer's Esc);
    closing the drawer mid-drag cancels it (the drawer stays mounted).
  - Visuals: the card dims in place; the copy is portaled to `document.body` (escapes the drawer's
    `transform`), moved by `transform` only, not `aria-modal` (leaves `topmostModal()` alone); the target
    column is highlighted; no shadow, blur, filter or reflow animation (VDI).
- [x] Task-row icon: opens the drawer on the last-used tab with the issue selected and scrolled into view;
  on List, a collapsed group holding it (e.g. Done) auto-expands.

### Board Testing — DESIGN §13.6

- [ ] Store: the tab defaults to List, is kept across close/reopen and re-hydrate, and is never persisted.
- [ ] Board: four columns always render; cards in the right column, newest first; empty column shows "No
  issues"; click selects; the selected card is highlighted.
- [ ] Drag: a cross-column drop calls `issues.update` with the new status (also onto an empty column);
  same-column and outside drops make no call; Esc cancels without closing the drawer; closing the drawer
  mid-drag cancels; the selection is unchanged.
- [ ] Drawer: a tab switch keeps the selection and unsaved edits with no prompt; same issue-view share on
  both tabs; placeholder with no selection; + New Issue on both tabs. Task-row icon opens the last-used tab
  and auto-expands a collapsed group.
- [ ] Existing-test updates: `IssueList` / `IssuesDrawer` tests for the moved + New Issue and the new pane
  widths; `group-issues.test.ts` passes unchanged.
- [ ] Edge cases: a linked issue dropped on Done (task stays linked); the selected issue deleted while on
  Board (placeholder); "Delete both" from the Progress window with the board open; many Done issues (only
  that column scrolls); a long name (two-line clamp); a narrow window (horizontal scroll).
- [ ] Manual: drag smoothness on the VDI host, no visual stalls.

## Jira import — orthogonal feature (DESIGN §13.7)

Goal (PRD §Issues → *Importing from Jira*): a manual, read-only fetch of Jira issues through the LiteLLM
MCP gateway, previewed in a modal as New/Duplicate/Conflict by `jiraKey`, with the selected New rows
imported as `source: 'jira'` Issues (§13, DESIGN §13.7). Orthogonal to Issues the same way Issues is
orthogonal to Tasks/Sessions — no change to `Task`, `Session`, the state lattice or the aggregator.
Implementation (Waves 1–4 of `docs/plans/jira-import_2026-10-14-plan.md`) is complete; tests (the `[ ]`
items below, one per subject) and the Wave 5 integration test / full gate are in progress.

### Domain (pure) — DESIGN §13.7

- [x] `src/domain/issue.ts`: `IssueSource` enum (`Local='local'`, `Jira='jira'`) + `parseIssueSource`;
  optional `source`/`jiraKey` on `IssueCreateProps` with read-only getters and no setters;
  `InvariantViolationError` when either field implies the other without it; carried through
  `fromSnapshot`/`toSnapshot`.
- [x] `src/domain/snapshots.ts`: required `source: IssueSource` + optional `jiraKey?: string` on
  `IssueSnapshot`.
- [x] New `src/domain/jira-import.ts`: plain value types `JiraIssue`/`JiraSprint`/`JiraProject`/
  `JiraClassification`/`JiraSprintFilter`; `composeJiraIssue(issue)` (name = `"KEY: Summary"`, trimmed the
  same way `Issue.create` normalizes names; description appends a DOD section only when non-empty);
  `classifyJiraIssue(composed, jiraKey, existingIssues)` (new/duplicate/conflict, matched on `jiraKey`
  then exact name/description equality); `orderSprints` (dedupe by id, active→future→closed);
  `matchesSprintFilter` (by id, or case-insensitive name substring).
- [ ] Tests: extend `src/domain/issue.test.ts` (source defaults to local, the source/key invariant, the
  snapshot round trip); new `src/domain/jira-import.test.ts` (compose, classify incl. edit→conflict and
  delete→new-again, sprint ordering/matching); extend `src/domain/workspace.test.ts` (hydrated/created
  issues default `source: 'local'`).

### Shared contract — DESIGN §13.7

- [x] `src/shared/dto.ts`: `IssueSourceDTO`; `source`/`jiraKey?` on `IssueDTO`; `JiraProjectDTO`/
  `JiraSprintDTO`/`JiraSprintFilterDTO`/`JiraFiltersDTO`; `JiraIssueRowDTO`/`JiraSearchPageDTO`;
  `JiraErrorDTO{kind: 'noKey'|'unauthorized'|'unreachable'|'gateway'|'invalid'}` + `JiraResultDTO<T>` (a
  typed envelope, since thrown `Error` subclasses don't survive IPC); `ImportJiraIssuesInput`/
  `ImportJiraIssuesResultDTO`/`SetJiraKeyInput`; `jira?: {lastFilters?: JiraFiltersDTO}` on
  `SettingsDTO`/`SettingsPatchDTO` (non-secret — the key itself is never here).
- [x] `src/shared/ipc.ts`: `CHANNELS.jiraProjects/jiraSprints/jiraSearch/jiraImport/
  credentialsSetJiraKey/credentialsHasJiraKey`; `OctopusAPI.jira`/`.credentials` groups.
- [x] New `src/shared/jira-key.ts`: pure `normalizeJiraIssueKey`/`isJiraIssueKey` (trim, uppercase,
  `PROJ-123` shape), shared the same way as `external-url.ts`.
- [ ] Test: new `src/shared/jira-key.test.ts`.

### Ports — DESIGN §13.7

- [x] New `src/ports/jira-issue-source.ts`: `JiraIssueSource` (`listProjects`/`listSprints`/`search`/
  `getIssues`), `JiraSearchFilters`, `JiraSearchPage`; `JiraSourceError` with
  `kind: 'noKey'|'unauthorized'|'unreachable'|'gateway'`.
- [x] `src/ports/credentials-provider.ts`: its **first implementation** — keep `resolve(ref)`, add
  `set(ref, secret: string|null)`/`has(ref)` and a `JIRA_API_KEY_REF` constant (I16).

### Adapters — DESIGN §13.7

- [x] New `src/adapters/jira/adf-to-markdown.ts`: pure, dependency-free ADF→Markdown (`adfToMarkdown`);
  paragraphs/headings/lists(nested)/code blocks/hard breaks/rules; strong/em/code/link marks; unknown
  nodes recurse into `content` else fall back to `text` else contribute nothing; output normalized
  (trimmed, 3+ blank lines collapsed) so classification's byte-for-byte comparison is stable.
- [x] New `test/fixtures/jira/` (captured once from the live gateway via the reference client, scrubbed
  of emails/avatar URLs/account IDs): `search-page1/2.json`, `search-no-issues.json`,
  `get-issue-batch.json`, `get-issue-sprints.json`, `projects.json`, `is-error.json`, `README.md`.
- [x] New `src/adapters/jira/litellm-jira-source.ts`: `LiteLLMJiraSource implements JiraIssueSource` over
  `POST {baseUrl}/mcp-rest/tools/call` (wire tool name carries the gateway's `jira_` alias prefix, e.g.
  `jira_jira_search`); `parseSearchText`/`parseProjectsText`/`parseIssueDetailsText` (string-aware brace
  scan) parse the three text-only response formats; batches `getIssues` 10 keys at a time; applies the
  sprint filter in the app (scanning whole 50-hit pages, capped, never splitting a page across cursors);
  maps errors to `noKey`/`unauthorized`/`unreachable`/`gateway`, never logging the key or headers.
- [ ] Test: new `src/adapters/jira/litellm-jira-source.test.ts` against the fixtures (request shape,
  parsing, batching, every error kind, sprint ordering/filtering/paging, the issue-key path).
- [x] `src/adapters/env/paths.ts`: `credentialsDir` (`<dataDir>/credentials`) on `AppPaths`;
  `ensureAppDirs` creates it mode 0700.
- [x] New `src/adapters/credentials/safe-storage-credentials.ts`: `SafeStorageCredentials implements
  CredentialsProvider` over an injected `safeStorage`-like object; `<dir>/<ref>.bin`, atomic write
  (temp+rename) mode 0600, `null` secret deletes the file; every `safeStorage` call deferred to
  method-invocation time (never touched at construction — `bootstrap()` runs before `app.whenReady()`);
  rejects clearly when encryption is unavailable, warns once (without the key) on the Linux
  `basic_text` backend.
- [ ] Tests: extend `src/adapters/env/paths.test.ts` (`credentialsDir`); new
  `src/adapters/credentials/safe-storage-credentials.test.ts` (set/has/resolve/clear, mode 0600,
  ciphertext not plaintext, encryption-unavailable rejection, missing-key throw).

### Settings (backend side) — DESIGN §13.7

- [x] `src/ports/settings-store.ts`: `JiraLastFilters`/`JiraSettings{lastFilters?}`, `jira?: JiraSettings`
  on `Settings`/`SettingsPatch` (documented non-secret).
- [x] `src/adapters/settings/json-settings-store.ts`: `pickJira` in `mergeSettings` (known keys only,
  `days` a positive integer, `sprint` one of the two shapes, everything else dropped;
  `DEFAULT_SETTINGS` has no `jira` block).
- [ ] Test: extend `json-settings-store.test.ts` (absent by default, patch round trip, malformed block
  dropped, unrelated patch keeps `lastFilters`).

### Persistence — schema v10 — DESIGN §13.7

- [x] `src/adapters/persistence/schema.ts`: `SCHEMA_VERSION = 10`; bootstrap `issues` DDL gains
  `source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','jira'))` and `jira_key TEXT`; a
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_jira_key ON issues(jira_key)` created unconditionally by
  `SqliteStore.create`, strictly after bootstrap *and* migrations — not inside `SCHEMA_STATEMENTS` or the
  v10 `Migration` — because SQLite's `ALTER TABLE ADD COLUMN` can't add a `UNIQUE` column and the point
  where `jira_key` is guaranteed to exist differs by DB vintage (fresh/v7/v8/v9).
- [x] Append-only `{ toVersion: 10 }` migration (`ALTER TABLE issues ADD COLUMN source ...`, `ALTER TABLE
  issues ADD COLUMN jira_key TEXT`), guarded by a new `Migration.unlessColumnExists {table, column}`
  (checked via `PRAGMA table_info` in `runMigrations`) — needed because a v7 DB's bootstrap already
  creates `issues` with both columns before any migration runs, so a bare `ALTER` there would fail
  "duplicate column". Never edit v1–v9 DDL.
- [x] `src/adapters/persistence/mappers.ts`: `source`/`jira_key` on `IssueRow`; `rowToIssueSnapshot`
  parses `source` via `parseIssueSource` (falls back to `local` on a corrupt value), NULL `jira_key` →
  `undefined`.
- [x] `src/adapters/persistence/sqlite-store.ts`: `upsertIssue` INSERT carries `source`/`jira_key`;
  `ON CONFLICT DO UPDATE SET` deliberately omits both (`Issue` exposes no setter for either — a routine
  re-save must never let them drift).
- [ ] Tests: extend `mappers.test.ts` (local/jira round trips, NULL key, corrupt source falls back) and
  `sqlite-store.test.ts` (FakeDb: v10 stamped, runs from 9, the v7-path ALTER-skip, no-op on a fresh DB,
  upsert SQL params).
- [x] `scripts/probe-sqlite-store.cjs`: v9→v10 and v7→v10 against the real `better-sqlite3` binary — old
  rows become `local`/NULL `jira_key`, a duplicate `jira_key` raises `UNIQUE`, a bad `source` raises
  `CHECK`, two NULL keys are allowed, `.bak-v9` is written.

### Application — DESIGN §13.7

- [x] New `src/application/queries/preview-jira-issues.ts`: `previewJiraIssues(deps, issues)` composes +
  classifies each fetched `JiraIssue` against `deps.workspace.issues()`; a pure read that bypasses the
  single-writer command loop entirely.
- [x] `src/application/commands.ts`: `ImportJiraIssuesInput{issues}` + `{kind:'importJiraIssues'}` command
  member; `importedCount?`/`skippedKeys?` on `CommandResult`; `jira?` on the application `SettingsPatch`.
- [x] New `src/application/use-cases/import-jira-issues.ts`: re-classifies every input issue against the
  **current** workspace (never trusts the modal's earlier preview) and additionally skips a key repeated
  within the same batch; builds each new issue via `Issue.create({source: Jira, jiraKey, status: Todo,
  no projectPath})`; persists all of them inside one `deps.persistence.transaction`, and only after it
  commits touches `Workspace`/`EventBus` (mirrors `create-issue.ts`'s persist-before-mutate order, so a
  mid-batch throw leaves memory/events untouched with no explicit rollback); returns the created count
  and the skipped keys.
- [x] `src/application/command-loop.ts`: routes `importJiraIssues`.
- [ ] `src/application/use-cases/test-fakes.ts`: `FakePersistence.failUpsertIssueAt?`, a
  `FakeJiraIssueSource`.
- [ ] Tests: new `preview-jira-issues.test.ts` and `import-jira-issues.test.ts` (creates the right
  issues; skips duplicates/conflicts even when requested; a repeated key in-batch is skipped; a mid-batch
  failure leaves the workspace/events untouched; one event per created issue); extend
  `create-issue.test.ts` (source is local) and the `IssueSnapshot` literals in `delete-task.test.ts`.

### Preload bridge

- [x] `src/preload/index.ts`: `jira.projects/sprints/search/import` and
  `credentials.setJiraKey/hasJiraKey`, each via `ipcRenderer.invoke`.

### Renderer — DESIGN §13.7

- [x] `src/renderer/src/store/store.ts`: hydrates/reduces `IssueDTO.source`/`jiraKey` unchanged;
  `setJiraLastFilters(filters)` patches only `settings.jira.lastFilters` (same pattern as
  `groupTasksByRepo`'s setter); the Settings modal's open state moves into the store as renderer-local,
  unpersisted view state (`settingsOpen`/`openSettings`/`closeSettings`), surviving `hydrate()` like the
  drawer fields — needed so the Jira modal's error states can close themselves, then open Settings,
  without the portaled Jira modal (which paints after `#root`) covering it.
- [x] `src/renderer/src/test-support/stub-bridge.ts`: `jira`/`credentials` groups (`hasJiraKey` resolves
  `false`, empty project list by default).
- [x] New `src/renderer/src/components/JiraImportModal.tsx`: follows the shared overlay contract
  (`.claude/rules/modals-and-overlays.md`) — portaled to `document.body` (opens from inside the Issues
  drawer, whose `transform` would otherwise confine a `position: fixed` backdrop), `role="dialog"` +
  `aria-modal="true"` + `tabIndex={-1}`, `onKeyDown` stops every key before handling its own Escape, no
  blur/filter. Filters prefill from `settings.jira.lastFilters` and persist on Fetch; an Issue key
  overrides every other filter; the Sprint dropdown loads per project (None/active/future/closed, or
  free-text fallback with no discoverable sprints). Rows show checkbox/key/summary/Jira
  status-type-assignee; Duplicate/Conflict rows are grayed, unselectable, labelled "Duplicated by
  \<name\>"/"Conflicts with \<name\>". A row click opens a read-only detail pane rendered with
  `IssueMarkdown`. Footer: Select all (New rows only), "N selected", Import. Distinct error states for no
  key / key rejected (both with Open Settings, closing this modal first) / gateway unreachable (Retry).
  Registered in `IssuesDrawer`'s `topmostModal()` doc-comment list.
- [x] `src/renderer/src/components/IssuesDrawer.tsx`: a "Fetch from Jira" header button after
  **+ New Issue** (opens `JiraImportModal`, works on both tabs); `IssueList.tsx`: a small "Jira" badge
  (plain paint, no filter) on `source==='jira'` rows.
- [x] `src/renderer/src/components/SettingsModal.tsx`: a "Jira API key" password field on the General
  tab (always starts empty; placeholder "Key saved" when `hasJiraKey()` is true); Save calls
  `credentials.setJiraKey` only when non-empty; a Clear key button calls `setJiraKey(null)`.
- [x] `src/renderer/src/components/ProgressPanel.tsx`: the local `showSettings` state replaced by the
  store's `settingsOpen`/`openSettings`/`closeSettings`.
- [x] `src/renderer/src/components/IssueDetail.tsx`: a read-only "Source: Jira (KEY)"/"Source: Local"
  line, never editable, absent from the edit form.
- [ ] Update the `IssueDTO` literals (`source: 'local'`) across existing renderer test fixtures
  (`App.test.tsx`, `DeleteTaskConfirm.test.tsx`, `IssuesDrawer.test.tsx`, `LinkTaskPicker.test.tsx`,
  `NewTaskModal.test.tsx`, `TaskListItem.test.tsx`, `store/group-issues.test.ts`, `store/store.test.ts`).
- [ ] Tests: new `JiraImportModal.test.tsx` (filters, rows, interaction, every error state, the
  window-`keydown`-never-fires spy per `NewTaskModal.test.tsx`); extend `store.test.ts`,
  `SettingsModal.test.tsx`, `ProgressPanel.test.tsx`, `IssueDetail.test.tsx`,
  `IssueList.test.tsx` (badge), `IssuesDrawer.test.tsx` (the header button on both tabs; Escape inside
  the Jira modal closes only the modal).

### Main — DESIGN §13.7

- [x] `src/main/dto-mappers.ts`: `toIssueDTO` carries `source`/`jiraKey`, `toSettingsDTO` carries `jira`;
  `toJiraIssueRowDTO`/`toJiraSprintDTO`/`toJiraProjectDTO`; `toJiraErrorDTO(err)` (a `JiraSourceError`
  maps to its kind, anything else to `gateway`, message scrubbed).
- [x] `src/main/ipc-handlers.ts`: `jira`/`credentials` added to `IpcHandlerHooks` (the `clipboard`
  precedent); exported pure validators `parseJiraFilters`/`parseImportKeys` (non-empty, capped, deduped,
  every key passing `isJiraIssueKey`) reject malformed input with `JiraErrorDTO{kind:'invalid'}` before
  any port call; `jira:projects`/`jira:sprints`/`jira:search` are queries that bypass the loop (`search`
  calls the port, then `previewJiraIssues`, then maps to row DTOs); `jira:import` validates, calls
  `port.getIssues(keys)` outside the loop, dispatches `importJiraIssues`, and reports keys Jira didn't
  return as skipped; `credentials:setJiraKey`/`credentials:hasJiraKey` (the key is never logged or
  returned — `hasJiraKey` returns only a boolean).
- [x] `src/main/composition-root.ts`: wires `SafeStorageCredentials(safeStorage, paths.credentialsDir)`
  and `LiteLLMJiraSource` (`fetch: globalThis.fetch`, the gateway base URL/server id, a `getApiKey`
  resolving `JIRA_API_KEY_REF`) into the IPC handlers — the only place either adapter is imported.
- [ ] Tests: extend `dto-mappers.test.ts` (source/jiraKey, settings.jira, each row DTO classification,
  error mapping) and `ipc-handlers.test.ts` (bad filters/keys rejected before any port call, the
  issue-key path, import fetches then dispatches, `hasJiraKey` never leaks the value, port errors map to
  the right `JiraResultDTO` kinds).

### Jira import Testing — DESIGN §13.7

- [ ] New `test/integration/jira-import.integration.test.ts`: a real `CommandLoop` over `makeDeps()` plus
  a fixture-serving `LiteLLMJiraSource` — search → preview (all New) → import; `Workspace.hydrate(load())`
  stands in for a reload, re-search shows Duplicate; `updateIssue` renames it → Conflict; `deleteIssue` →
  New again.
- [ ] Full gate: `npm run typecheck && npm run lint && npm run test && npm run format:check`, including
  the boundaries rule (no `adapters` import outside `composition-root.ts`, no `ports` import in the
  renderer, `domain` imports nothing) — plus a manual smoke test against the live gateway: no key → Open
  Settings → save key → fetch a project → sprint dropdown → import → badge → re-fetch shows Duplicate.
