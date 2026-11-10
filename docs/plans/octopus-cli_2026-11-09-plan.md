# Octopus CLI - Plan

**Feature**: Claude Code drives a running Octopus through `octopus-cli`: a Node entry run by the
bundled Electron with `ELECTRON_RUN_AS_NODE`, which speaks NDJSON to a Unix-socket control server in
main at `<dataDir>/control.sock` (directory 0700). Each request is validated by the same DTO→command
layer as IPC and runs through the CommandLoop. v1 covers: list projects, create and list tasks
(background), open a session with an optional one-shot prompt, and list, get and add issues. A thin
skill and the installer complete the feature.

Layering note: adapters may import only `adapters`, `ports`, `domain` and `shared`. So
`src/adapters/control/` is transport only and receives a `handle(request)` callback. Method routing
and validation live in `src/main/`.

## Wave 1 (parallel)
### [x] Subject 1: Control protocol contract
**Files:** src/shared/control-protocol.ts (new), src/shared/control-protocol.test.ts (new)

- [x] Define `CONTROL_PROTOCOL_VERSION` and the method names: `projects.list`, `task.create`, `task.list`, `session.open`, `issues.list`, `issues.get`, `issues.add`
- [x] Define the request envelope `{id, version, method, params}`, the reply `{id, ok, result | error:{code,message}}`, and per-method param/result types
- [x] Add pure `parseControlRequest(line)` validation with these error codes: unknown method, bad payload, version mismatch, bad JSON
- [x] Add a pure data-dir + `controlSocketPath` resolver (shared by `paths.ts` and the CLI) and the `OCTOPUS_CONTROL_SOCKET` env-var name constant

### [x] Subject 2: Application background semantics + result ids
**Files:** src/application/commands.ts, src/application/use-cases/create-task.ts, src/application/use-cases/open-session.ts, src/application/use-cases/start-session-runtime.ts, src/application/use-cases/start-task-sessions.ts, src/ports/event-bus.ts, src/shared/events.ts, src/main/dto-mappers.ts

- [x] `CreateTaskInput.background?`: skip `setActiveTask` / `activeTaskChanged`. Return `taskId` once the task is Ready, and return an error on provisioning failure
- [x] `CreateSessionInput.background?` and `launchCommand?`: the one-shot launch command is passed only to the first fresh spawn and is never written into `SessionConfig`. Leave the existing `initialCommand` behavior unchanged
- [x] `CommandResult` gains `taskId?` and `sessionId?`, filled in by createTask/createSession
- [x] `sessionCreated` domain event and DTO carry `background`. Map it in dto-mappers.ts

### [x] Subject 3: Paths + PTY env
**Files:** src/adapters/env/paths.ts, src/adapters/env/paths.test.ts, src/shared/pty-env.ts, src/shared/pty-env.test.ts

- [x] Add `controlSocketPath` (reusing the Subject 1 resolver) to the resolved paths (a `promptsDir` was later dropped when `session open` switched from `--prompt` to a generic one-shot `--command`)
- [x] Export `OCTOPUS_CONTROL_SOCKET` into session env from pty-env.ts. The value is injected by the caller

### [x] Subject 4: Skill + install/release packaging
**Files:** resources/claude-skill/octopus/SKILL.md (new), resources/octopus-cli (new launcher script), install.sh, uninstall.sh, scripts/release.mjs, electron-builder.yml

- [x] SKILL.md: when to use Octopus, and two workflows: create task → open session with prompt per worktree, and brainstorm → `issues add`. Point to `octopus-cli --help`
- [x] Launcher script: run the bundled Electron with `ELECTRON_RUN_AS_NODE=1` on `out/main/cli.js`. Use the same resolution style as octopusd
- [x] install.sh symlinks `octopus-cli` into `~/.local/bin` and copies the skill to `~/.claude/skills/octopus`. uninstall.sh removes both. release.mjs stages both. Confirm `resources/**` packaging covers them

## Wave 2 (depends on Wave 1)
### [x] Subject 5: Control server adapter
**Files:** src/adapters/control/control-server.ts (new), src/adapters/control/control-server.test.ts (new)

- [x] `createControlServer({socketPath, handle, logger})`: create the directory with mode 0700 and the socket with mode 0600
- [x] Stale-socket cleanup: probe-connect; on ECONNREFUSED, unlink and listen. If another server is live, fail without stealing the socket
- [x] NDJSON line buffer that handles split chunks and multiple requests per connection. Replies are matched by `id`. Concurrent requests are allowed
- [x] `close()`: stop listening, unlink the socket, and reply `shutting_down` to requests still in flight

### [x] Subject 6: Shared command validation + control dispatcher
**Files:** src/main/command-validation.ts (new), src/main/ipc-handlers.ts, src/main/ipc-handlers.test.ts, src/main/ipc-handlers.groups.test.ts, src/main/control-handlers.ts (new), src/main/control-handlers.test.ts (new)

- [x] Move the DTO→command validators out of ipc-handlers.ts into command-validation.ts. IPC behavior stays unchanged
- [x] control-handlers.ts maps each protocol method to a query (list projects, get-state for tasks/issues) or a loop command
- [x] `task.create`: look up the project by name (error if unknown). The source branch defaults to the project's default branch and the name defaults to the branch. Send with `background: true` and return `taskId`
- [x] `session.open`: reject unknown or non-Ready task ids. If a command is given, validate it (`checkLaunchCommand`: one line, ≤ `MAX_COMMAND_BYTES`) and pass it as the one-shot `launchCommand` (replaced the original prompt-file design). Use `background: true` and return `sessionId`
- [x] `issues.add`: accept name, description, optional project and optional status, and return the issue id. `issues.list` filters by status and project. `issues.get` returns one issue

### [x] Subject 7: CLI layer
**Files:** src/cli/index.ts (new), src/cli/args.ts (new), src/cli/client.ts (new), src/cli/*.test.ts (new), electron.vite.config.ts, eslint.config.mjs, tsconfig.node.json

- [x] Add a third main-side input `cli` → `out/main/cli.js`, following the daemon entry pattern
- [x] Add a `cli` boundaries element that may import `cli` and `shared` only. Include `src/cli/**` in tsconfig.node.json
- [x] Argument parser for all v1 commands, plus `--help` (global and per command). `issues add` reads the description from stdin
- [x] Client: socket path comes from `OCTOPUS_CONTROL_SOCKET`, else the data-dir default. On ENOENT or ECONNREFUSED, print a clear "Octopus is not running" error
- [x] Output is JSON only on stdout, with errors as JSON on stderr. Exit codes: 0 ok, 1 command error, 2 usage, 3 not running

### [x] Subject 8: Renderer store background handling
**Files:** src/renderer/src/store/store.ts, src/renderer/src/store/store.test.ts

- [x] A `sessionCreated` with `background` adds the session but does not move the tab mark or change the active task

## Wave 3 (depends on Wave 2)
### [x] Subject 9: Composition wiring
**Files:** src/main/composition-root.ts, src/main/index.ts

- [x] Build the control server with `handle` = control-handlers bound to the loop and deps. Pass the socket path into pty-env
- [x] Start the server after the single-instance lock. Close it on quit before loop shutdown

### [x] Subject 10: Docs
**Files:** CHANGELOG.md, DESIGN.md, CLAUDE.md

- [x] DESIGN: control socket section (protocol, version, 0700 security, dispatch through the CommandLoop, one-shot prompt semantics, and the note that a persisted `initialCommand` re-runs on fresh spawn)
- [x] CLAUDE.md: `cli/` layer + boundary rule, third vite entry, `paths.ts` additions. CHANGELOG entry

## Testing

- [x] control-protocol: unknown method, bad payload, version mismatch, malformed JSON
- [x] control-server: split chunks, multiple requests per connection, concurrent clients, 0700 directory, stale-socket unlink, live second instance not clobbered, close mid-request
- [x] CLI: parsing, `--help` lists every command, JSON output, exit codes, ENOENT and ECONNREFUSED → "Octopus is not running", stdin description
- [x] create-task tests: background skips activation, `taskId` returned on Ready, provisioning failure → error
- [x] open-session / start-session-runtime tests: launch command written once on fresh spawn, absent from persisted SessionConfig, not re-run on restore or reattach
- [x] store tests: background `sessionCreated` leaves the mark and active task unchanged
- [x] Prompt with quotes, newlines, `$()` and backticks arrives verbatim, and the prompt file is deleted (real shell, integration test)
- [x] Update ipc-handlers*.test.ts after the extraction. Update pty-env.test.ts and paths.test.ts
- [x] New test/integration/control-socket integration test: socket → control-handlers → CommandLoop → fake worktree provider. Covers unknown project, unknown or non-Ready task id, and concurrent CLI calls
- [x] `npm run lint` passes with the new `cli` boundary

## Acceptance Criteria
- With Octopus running, `octopus-cli projects list | task create | task list | session open | issues list/get/add` return JSON and the correct exit codes. When Octopus is not running, the CLI exits with code 3 and a clear message
- A CLI-created task or session does not steal focus, the active task or the tab mark
- The prompt runs exactly once. A restarted session is a plain shell. The prompt file is gone after launch
- IPC and the socket share one validation path and both go through the CommandLoop
- `cli/` imports only `shared`, enforced by eslint
- install.sh and uninstall.sh install and remove the launcher and skill. The release tarball contains both
- CHANGELOG, DESIGN.md and CLAUDE.md are updated
