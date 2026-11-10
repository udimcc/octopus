# Rule: octopus-cli / control socket invariants (DESIGN §14)

Applies to `src/shared/control-protocol.ts`, `src/shared/data-paths.ts`, `src/adapters/control/`,
`src/main/control-handlers.ts`, `src/cli/`,
`resources/octopus-cli`, `resources/claude-skill/octopus/` and the `background` / `launchCommand`
fields on `CreateTaskInput` / `CreateSessionInput`.

- **Bump `CONTROL_PROTOCOL_VERSION`** on any incompatible change to the envelope or a method's
  params/result. An installed CLI and a newer/older app must fail with `version_mismatch`, not
  misparse. Params are strict (an undeclared param is `bad_request`): declare every new optional
  param in `PARAM_SPECS`, or the app rejects it.
- **Every write goes through the CommandLoop** (single writer, §6.5). Handlers may read snapshots
  for validation, but anything that depends on state at execution time (e.g. the target window
  of a background session) is resolved **inside** the use case, not in the handler: a
  `task.create` ahead in the queue can block for minutes.
- **The session command is one-shot.** It travels as `launchCommand` and is never written into
  `SessionConfig` (a persisted `initialCommand` re-runs on every fresh spawn). It must stay a single
  line within `MAX_COMMAND_BYTES` (`checkLaunchCommand`); the caller owns quoting. IPC (`ipc-handlers.ts`) must
  never let the renderer pass `launchCommand` or `background`.
- **Background means no focus steal.** It brings no activation, no mark move, no toast and no
  New-Task modal reaction. It seeds a mark only for a task that has none, and the pane's
  mount-time focus is suppressed by the `noFocusOnMount` hint. Any new event emitted on a
  background path must carry `background` through `toEventDTO`.
- **Socket safety:** the socket is 0600 inside the 0700 data dir. Only ECONNREFUSED/ENOENT mark a
  socket as stale, and any other probe outcome fails closed (never unlink a live socket).
- **`cli/` imports only `shared`** (eslint boundaries). The CLI writes JSON on stdout only (the one opt-in
  exception is `issues get --markdown`; errors stay JSON on stderr), with
  exit codes 0 ok / 1 command error / 2 usage / 3 not running.
- **Keep `src/cli/help.ts` and `resources/claude-skill/octopus/SKILL.md` in sync** with the
  commands, flags and output fields. The skill is Claude's only guide to the CLI.
