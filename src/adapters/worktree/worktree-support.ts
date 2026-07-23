/**
 * Shared helpers for the worktree providers (DESIGN §6.4). Both the repo-local
 * `ScriptWorktreeProvider` and the `NativeGitWorktreeProvider` run through the
 * same argv-only {@link ScriptRunner} (I17) and need the same env overlay,
 * stdout-line parsing, and dirtiness check — kept here so the two adapters stay
 * thin and the `isDirty` git invocation is defined in exactly one place.
 */

import type { TaskId } from '../../domain/ids'
import type { ScriptRunner } from '../../ports/script-runner'
import { CURRENT_VERSION } from '../../shared/version'

/** The git executable — resolved from PATH by the runner (argv, never a shell). */
export const GIT = 'git'

/**
 * The `OCTOPUS_*` env overlay handed to every worktree script / git invocation
 * (§6.4). `OCTOPUS_REPO_ROOT` is the task's chosen repo directory.
 */
export function scriptEnv(taskId: TaskId, repoDir: string): Record<string, string> {
  return {
    OCTOPUS_REPO_ROOT: repoDir,
    OCTOPUS_TASK_ID: taskId,
    OCTOPUS_VERSION: String(CURRENT_VERSION)
  }
}

/** First non-empty line of `text` (the create contract's worktree path, §6.4). */
export function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) {
      return line
    }
  }
  return ''
}

/** First line of `text` (used to keep an error message to one line). */
export function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/**
 * `git -C <wt> status --porcelain` non-empty ⇒ dirty (§6.4). If git itself fails
 * we cannot prove cleanliness, so we report dirty to force the confirm dialog
 * rather than silently deleting. Provider-neutral: the selector shares one copy.
 */
export async function gitIsDirty(runner: ScriptRunner, worktreePath: string): Promise<boolean> {
  const result = await runner.run(GIT, ['-C', worktreePath, 'status', '--porcelain'], {
    cwd: worktreePath
  })
  if (result.exitCode !== 0) {
    return true
  }
  return result.stdout.trim().length > 0
}
