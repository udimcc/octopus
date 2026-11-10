---
name: octopus
description: Drive the Octopus desktop IDE through its CLI (`octopus-cli`). Use when the user asks you to open Octopus tasks, worktrees or sessions (including starting a Claude session to implement an issue), run work in parallel worktrees/sessions, or record or read Octopus issues (including turning a brainstorm into issues).
---

# Octopus

Octopus is a desktop IDE where each **task** owns an isolated git worktree and holds one or more
**sessions** (terminals; with a command, e.g. an interactive Claude). `octopus-cli` controls the running app.

## Ground rules

- **You dispatch; the new session does the work.** When asked to start a session that does some
  work, do not research, plan or implement that work yourself, and do not read the code to enrich
  the prompt. Write the prompt from what you already have (the user's words, the issue text), open
  the session, report, stop.
- **Add no decisions of your own.** The prompt carries only the work and instructions the user gave.
  Do not resolve open questions yourself (a Blocked issue's reasons, ambiguities, scope choices):
  the session raises them with the user.
- Syntax: always run `octopus-cli --help` and `octopus-cli <cmd> --help` first; do not guess flags.
- Output is JSON (except `issues get --markdown`). Exit codes: 0 ok, 1 command error, 2 usage error, 3 Octopus not running.
- On exit 3, tell the user to start Octopus. Never try to launch it yourself.
- Task refs are ids. "This task" is `$OCTOPUS_TASK_ID` (set inside an Octopus session). For a task
  the user names, find its id in `octopus-cli task list` by name or branch; if none or several
  match, ask the user.
- Sessions open in the background. You launch only; do not monitor. The user watches them in Octopus.
- Always name a session you open: `--name <name>` is its tab title, at most 30 characters (else
  `bad_request`). Make it short and specific, e.g. `TM-2675 China rejects`, not the full issue title.

## Starting Claude in a session

`session open` takes a shell command (`--command <cmd>`, or `--command -` for stdin) that is typed
once into the new terminal; without it the session is a plain shell. The command must be a single
line of at most 4000 bytes (else `bad_request`), so never put a prompt in it. Instead write the
prompt to a temp file and let the shell read and delete it:

```bash
F=$(mktemp)
cat > "$F" <<'EOF'
<the prompt, any text>
EOF
octopus-cli session open <taskId> --name "<short name>" --command "claude -- \"\$(cat '$F'; rm -f '$F')\""
```

The new session has none of your conversation context: the prompt must stand on its own.

## Workflow A: implement an issue in a session

1. Find the issue: `octopus-cli issues list`, match the user's name or key, note its id.
2. Resolve the task (see Ground rules). Create a new task only if the user asks for a new worktree
   (Workflow B, step 2).
3. Open the session with the issue copied into the prompt by the CLI (do not retype it):

   ```bash
   F=$(mktemp)
   { cat <<'EOF'
   Implement the Octopus issue below in this worktree. <only instructions the user gave, if any>
   EOF
   octopus-cli issues get <issueId> --markdown; } > "$F" &&
   octopus-cli session open <taskId> --name "<short name>" --command "claude -- \"\$(cat '$F'; rm -f '$F')\""
   ```

4. Report in one line, the session name and id, then stop. Do not summarize the issue.

## Workflow B: parallel implementation

1. `octopus-cli projects list` to find the project name(s).
2. For each independent piece of work, `octopus-cli task create ...` (one worktree each). It blocks
   until the task is Ready and returns `taskId`: run it with a long Bash timeout, and if it times out
   check `octopus-cli task list` before retrying (the create still completes in the app).
3. Open a Claude session per task (see "Starting Claude in a session"). Its prompt carries what you
   already know: goal, constraints, definition of done, and files the conversation already named.
4. Report the task and session names and ids, one line each, then stop.

## Workflow C: brainstorm to issues

1. `octopus-cli issues list` first, to avoid duplicates.
2. For each new item, `octopus-cli issues add ...` with a short name and a markdown description via
   `--description <text>` or `--description -` (reads stdin; a plain pipe without `-` is ignored) (see `issues add --help`).
3. Tell the user which issues were added (ids and names).
