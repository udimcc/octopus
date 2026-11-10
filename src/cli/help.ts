/** Help texts for `octopus-cli`. Pure strings; every command is listed in {@link GLOBAL_HELP}. */

const EXIT_CODES = `Exit codes:
  0  ok (result JSON on stdout)
  1  command error (error JSON on stderr: {"error":{"code","message"}})
  2  usage error (message on stderr)
  3  Octopus is not running (error JSON on stderr, code "not_running")`

export const GLOBAL_HELP = `octopus-cli - control a running Octopus app

Usage: octopus-cli <command> [options]

Commands:
  projects list                 List registered projects
  task create                   Create a task (worktree); blocks until Ready
  task list                     List tasks
  session open <taskId>         Open a background session in a task
  issues list                   List issues
  issues get <issueId>          Show one issue with its description
  issues add                    Add an issue

Run "octopus-cli <command> --help" for details (e.g. "octopus-cli task create --help").

Output: one compact JSON document on stdout (except "issues get --markdown"). Command errors are JSON on stderr; usage errors are plain text.
Socket: $OCTOPUS_CONTROL_SOCKET, else <data dir>/control.sock.

${EXIT_CODES}
`

const HELP: Record<string, string> = {
  'projects list': `Usage: octopus-cli projects list

List registered projects.
Output: {"projects":[{"name","path","defaultBranch"?}]}

${EXIT_CODES}
`,
  'task create': `Usage: octopus-cli task create --project <name> --branch <branch> [options]

Create a task with its own git worktree. Blocks until provisioning finishes (no timeout:
cloning/provisioning can be slow); use a long timeout, and check "task list" before retrying
a timed-out create (it still completes in the app). The task is created in the background and does not take focus.

Options:
  --project <name>        Project name (see "projects list")  [required]
  --branch <branch>       Branch for the worktree             [required]
  --source-branch <b>     Branch to start from
  --name <name>           Task display name
  -h, --help              Show this help

Output: {"taskId":"..."}

${EXIT_CODES}
`,
  'task list': `Usage: octopus-cli task list [--project <name>]

List tasks.
Output: {"tasks":[{"id","name","project","branch","state","worktreePath"?,"issueId"?}]}

Options:
  --project <name>        Only tasks of this project
  -h, --help              Show this help

${EXIT_CODES}
`,
  'session open': `Usage: octopus-cli session open <taskId> [--name <name>] [--command <cmd> | --command -]

Open a new background session in a task. Without --command it is a plain shell terminal; with
--command the line is typed once into the new shell (single line, max 4000 bytes; you own the
quoting). A command starting with "-" needs --command=<cmd> or "--command -" (stdin).

Options:
  --command <cmd|->       Command line to run in the shell; "-" reads stdin
  --name <name>           Tab title, max 30 characters (default: an automatic title)
  -h, --help              Show this help

Output: {"sessionId":"..."}

${EXIT_CODES}
`,
  'issues list': `Usage: octopus-cli issues list [--status <status>] [--project <p>]

List issues.
Output: {"issues":[{"id","name","status","project"?,"taskId"?}]}

Options:
  --status <status>       todo | in_progress | blocked | in_review | done
  --project <p>           Project name or absolute path
  -h, --help              Show this help

${EXIT_CODES}
`,
  'issues get': `Usage: octopus-cli issues get <issueId> [--markdown]

Show one issue.
Output: {"issue":{"id","name","status","description",...}} (+ "blockedReasons" when set)

Options:
  --markdown              Print the issue as readable markdown instead of JSON
                          (title, id, status, blocked reasons, description)
  -h, --help              Show this help

${EXIT_CODES}
`,
  'issues add': `Usage: octopus-cli issues add --name <name> [options]

Add an issue.

Options:
  --name <name>           Issue title  [required]
  --description <text|->  Markdown description; "-" reads stdin (default: empty)
  --project <p>           Project name or absolute path
  --status <status>       todo (default) | in_progress | blocked | in_review | done
  -h, --help              Show this help

Output: {"issueId":"..."}

${EXIT_CODES}
`
}

export function helpFor(command: string): string | undefined {
  return HELP[command]
}
