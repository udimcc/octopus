# Octopus CLI — Design

**Date:** 2026-11-09
**Goal:** Let Claude Code drive a running Octopus: open worktree tasks, open sessions (optionally
with a Claude prompt) and read/add Issues.

## Use cases

1. **Parallel implementation.** The user brainstorms with Claude. Claude creates N worktree tasks,
   opens a session in each with a Claude prompt, and the main Claude coordinates them. The user
   watches the sub-sessions in the Octopus UI.
2. **Brainstorm → Issues.** The user tells Claude to record brainstormed items as Octopus Issues.

## Product decisions

| Topic | Decision |
|---|---|
| Orchestration scope | **Launch only**: the listed abilities, with no status polling and no I/O to sub-sessions |
| UI behavior | **Background**: no focus steal, the active task and tab mark don't move, no toast |
| App not running | Fail with a clear "Octopus is not running" error (exit code 3) and never auto-launch |
| Claude session | Interactive `claude -- "<prompt>"`, started by the caller via `session open --command` (without a command, `session open` is a plain shell), so the user can take over in the tab and status icons work as usual |
| New worktree | A defined Octopus project (by name) + a new branch. The source branch defaults to the project's default branch, and the task name defaults to the branch |
| Issues | Add: name, markdown description (from stdin), optional project, optional status. List with status/project filters. Get one issue with its description |
| Task reference | **Ids only**: the CLI is for Claude, not humans |
| Composition | The CLI keeps "new worktree" and "new session" as separate commands. The skill composes them |
| Distribution | The skill is for Claude only. install.sh installs it (and the CLI on PATH), and uninstall.sh removes it |

## Approach (chosen: A)

A control socket in the main process, the `octopus-cli` Node entry, and a thin Claude Code skill.

Rejected:
- **MCP server**: tool schemas would load into every Claude session, and it adds an SDK dependency.
- **CLI writes SQLite directly**: breaks the single-writer invariant (DESIGN §6.5).

## Architecture

- The **main process** listens on a Unix socket keyed to the data dir (`<dataDir>/control.sock`,
  directory mode 0700, the same uid capability gate as octopusd). A dev build sharing the installed app's data dir shares its socket.
- **Protocol**: NDJSON request/reply with a version field, defined in `src/shared/control-protocol.ts`
  (transport-agnostic, like `ipc.ts`).
- **Dispatch**: `issues.add` shares extracted validators with the Electron IPC handlers; other methods are
  validated by control-protocol parsing and the same CommandLoop/use-case invariants. Then through the **CommandLoop**. The UI updates live
  through the normal event bus.
- **Transport adapter** (`src/adapters/control/`): socket, framing and lifecycle only. Method
  routing lives in `src/main/` (adapters may not import `application`).
- **CLI** (`src/cli/`, a new layer that may import `shared` only): a third electron-vite Node entry
  (`out/main/cli.js`), run by the bundled Electron with `ELECTRON_RUN_AS_NODE`, the same way
  octopusd runs, so it needs no host Node. Output is JSON only on stdout. Exit codes: 0 ok, 1 command
  error, 2 usage, 3 not running. `--help` documents every command.
- **Socket discovery**: `OCTOPUS_CONTROL_SOCKET` (exported into every session's PTY env), otherwise
  the data-dir default. The pure resolver lives in `shared/` so that both `paths.ts` and the CLI use it.

## Key behaviors and findings

- **`task create` blocks until Ready.** `createTask` already provisions inside the single-writer
  loop, so the reply arrives only once the task is Ready or has failed. No polling is needed. As a
  consequence, parallel creates run one after another, which is acceptable (seconds each) and the
  same as UI-created tasks.
- **The command is one-shot.** A persisted `initialCommand` re-runs on every fresh spawn
  (`start-session-runtime.ts`), e.g. after an app restart on the in-process backend. So the Claude
  command is **not** stored in `SessionConfig`. It is a one-shot launch command delivered only on
  the first spawn. After a restart the session is a plain shell; with the daemon backend the live
  Claude simply re-attaches. `claude --continue` was rejected: it resumes the latest conversation in
  the cwd, which is ambiguous when several Claudes share a worktree.
- **Command transport**: `session open --command <cmd>` is typed once into the new shell. It must be a
  single line of at most 4000 bytes (tty canonical-mode line buffer is 4096); the caller owns quoting.
  The skill passes the prompt through a temp file: `claude -- "$(cat F; rm -f F)"`. Needs a POSIX-family
  `$SHELL` (fish ≥ 3.4).
- **Background**: `CreateTaskInput.background` skips activation. `CreateSessionInput.background`
  is carried on `sessionCreated`, so the renderer doesn't move the tab mark. `CommandResult` returns
  `taskId`/`sessionId`.
- **No claude-args pass-through**: the sub-Claude's permission prompts appear as "Needs input" in
  Octopus (the existing UX).

## Commands (v1)

`projects list` · `task create` · `task list` · `session open <taskId> [--name <name>] [--command <cmd>|-]` · `issues list` ·
`issues get <id> [--markdown]` · `issues add`

## The skill

`~/.claude/skills/octopus/SKILL.md`, kept thin. It covers when to use Octopus and the two workflows
(create a task, then open a session with a command per worktree; brainstorm, then add issues), and
points to `octopus-cli --help` for syntax.

## Testing

- **Unit**: protocol validation; server framing, concurrency and stale/second instance; CLI parsing,
  exit codes and stdin; background create; launch command once and never persisted or re-run;
  renderer store background handling.
- **Shell integration**: the skill's temp-file recipe delivers the prompt verbatim and the file is deleted.
- **Integration**: socket → handlers → CommandLoop → fake worktree provider, including error cases
  (unknown project, unknown or non-Ready task, concurrent calls).
- **Updated tests**: `ipc-handlers`, `pty-env` and `paths` tests. Lint passes with the new `cli`
  boundary.
