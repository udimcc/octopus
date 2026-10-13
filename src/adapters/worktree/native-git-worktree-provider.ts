/**
 * `WorktreeProvider` where Octopus runs `git worktree` ITSELF (DESIGN §6.4). Used
 * when a task's repo directory has no `create_worktree.sh` — the script-less
 * default path. Git is invoked through the SAME argv-only {@link ScriptRunner}
 * (I17, `shell:false`), so an untrusted branch name is never interpolated into a
 * shell — it is just an argv string git receives verbatim.
 *
 * `create`:
 *   - computes a FLAT path under the resolved base dir `worktree.location`
 *     (`<base>/<sanitized-new-branch>-<short-task-id>`, {@link computeWorktreePath}),
 *     ensuring the base exists first (git won't create the parent).
 *   - runs `git -C <repoDir> worktree add -b <newBranch> <computedPath> <sourceBranch>`;
 *     stderr streams as progress. Non-zero exit / timeout / invalid path → reject.
 *
 * `remove`:
 *   - `assertSafeToDelete` (containment, §6.4) BEFORE git runs.
 *   - runs `git -C <repoDir> worktree remove <path>` — with `--force` when the
 *     caller confirmed a dirty delete (git refuses a dirty tree otherwise, §6.4).
 *   - resolves even on non-zero exit (I4); rejects only on spawn failure.
 *
 * `isDirty`: shared `git status --porcelain` helper.
 *
 * `inspectRepo`/`listWorktrees`: both run the same `git worktree list --porcelain`.
 * `inspectRepo` resolves to the FIRST record (`parseMainWorktree`) — git always
 * lists the repo's main record first: the main checkout for a normal repo, or
 * the bare directory itself for a bare repo (which can still be followed by zero
 * or more linked worktrees of its own) — and additionally probes for a default
 * branch (`origin/HEAD`, else the current branch). `listWorktrees` reuses
 * {@link parseWorktreeList}, which filters out bare/prunable records: it is the
 * "pick a checkout" list, and a bare dir or a pruned worktree isn't one.
 */

import { normalize, sep } from 'node:path'
import type { Settings } from '../../ports/settings-store'
import type { ScriptRunner } from '../../ports/script-runner'
import type {
  WorktreeProvider,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  AdoptWorktreeRequest,
  AdoptWorktreeResult,
  RemoveWorktreeRequest,
  InspectRepoResult,
  RepoWorktree
} from '../../ports/worktree-provider'
import { validateWorktreePath, assertSafeToDelete, type PathProbe } from './path-safety'
import { fsPathProbe } from './fs-path-probe'
import { computeWorktreePath } from './worktree-path'
import { GIT, scriptEnv, firstNonEmptyLine, firstLine, gitIsDirty } from './worktree-support'

/**
 * Timeout for the read-only `inspectRepo`/`listWorktrees` git calls. `inspectRepo`
 * runs inside the single-writer command loop (`seedProjects` at boot, `addProject`
 * on demand) — unlike `create`'s `worktreeCreateTimeoutMs` (user configurable,
 * long-running by nature), a hung `git` there would stall the whole loop, so a
 * short, fixed timeout protects it. `listWorktrees` doesn't run in the loop — it
 * backs the `listProjectWorktrees` query, which bypasses the loop entirely
 * (§6.4/§6.5) — but shares the same fixed timeout for the same reason: it's a
 * read-only git call that should fail fast rather than hang.
 */
const INSPECT_TIMEOUT_MS = 10_000

/** Normalize + strip a single trailing separator (keep root) for path identity. */
function canonPath(p: string): string {
  const n = normalize(p.trim())
  if (n.length > 1 && n.endsWith(sep)) {
    return n.slice(0, -1)
  }
  return n
}

/**
 * One `git worktree list --porcelain` record, before any filtering. `bare` means
 * the record is the repo's bare directory (no working tree); `prunable` means
 * git has flagged a linked worktree whose directory is gone from disk.
 */
interface WorktreeRecord {
  readonly path: string
  readonly branch?: string
  readonly bare: boolean
  readonly prunable: boolean
}

/**
 * Parse `git worktree list --porcelain` output into one {@link WorktreeRecord}
 * per record (blank-line separated). Within a record, `worktree <p>` is the path
 * and `branch refs/heads/<b>` is the branch (prefix stripped); a `detached`
 * record has no branch line, so `branch` is `undefined` naturally.
 */
function parseWorktreeRecords(porcelain: string): WorktreeRecord[] {
  const records = porcelain.split(/\n\s*\n/)
  const result: WorktreeRecord[] = []
  for (const record of records) {
    let path = ''
    let branch: string | undefined
    let bare = false
    let prunable = false
    for (const line of record.split('\n')) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim()
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length).trim()
      } else if (line === 'bare') {
        bare = true
      } else if (line.startsWith('prunable')) {
        prunable = true
      }
    }
    if (path === '') {
      continue
    }
    result.push({ path, branch, bare, prunable })
  }
  return result
}

/**
 * The public worktree list, for the "From Existing Repo" picker (§6.4): every
 * record MINUS a `bare` one (no checkout a task could use) and MINUS a
 * `prunable` one (the worktree's directory is already gone from disk, so
 * adopting it would fail later).
 */
export function parseWorktreeList(porcelain: string): RepoWorktree[] {
  return parseWorktreeRecords(porcelain)
    .filter((r) => !r.bare && !r.prunable)
    .map((r) => ({ path: r.path, branch: r.branch }))
}

/**
 * The main worktree/repo-root path from `git worktree list --porcelain` output:
 * the FIRST record, unconditionally (git always lists the repo's main record —
 * the main checkout, or the bare directory for a bare repo — first). Deliberately
 * NOT filtered through {@link parseWorktreeList}: that filter drops `bare`
 * records, which would make a bare repo's main record disappear and leave the
 * "main worktree" as whichever linked worktree happens to sort next (if the bare
 * repo has any), or nothing. Returns `''` if there is no record (or it has no
 * `worktree ` line).
 */
function parseMainWorktree(porcelain: string): string {
  return parseWorktreeRecords(porcelain)[0]?.path ?? ''
}

export interface NativeGitWorktreeProviderDeps {
  readonly runner: ScriptRunner
  /** Live settings accessor (create timeout). */
  readonly getSettings: () => Settings
  /**
   * Resolve (and ensure on disk) the base dir for native worktrees — the
   * composition root wires this to `ensureWorktreeBase(resolveWorktreeBase(...))`,
   * so path/default policy stays out of this adapter (§6.4).
   */
  readonly resolveBase: () => string
  /** Path probe for validation; defaults to the real fs probe. */
  readonly probe?: PathProbe
  /** Sink for the non-fatal "doesn't look like a worktree" warning (§6.4). */
  readonly onWarning?: (message: string) => void
}

export class NativeGitWorktreeProvider implements WorktreeProvider {
  private readonly runner: ScriptRunner
  private readonly getSettings: () => Settings
  private readonly resolveBase: () => string
  private readonly probe: PathProbe
  private readonly onWarning?: (message: string) => void

  constructor(deps: NativeGitWorktreeProviderDeps) {
    this.runner = deps.runner
    this.getSettings = deps.getSettings
    this.resolveBase = deps.resolveBase
    this.probe = deps.probe ?? fsPathProbe
    this.onWarning = deps.onWarning
  }

  async create(
    req: CreateWorktreeRequest,
    onProgress?: (line: string) => void
  ): Promise<CreateWorktreeResult> {
    const settings = this.getSettings()
    const base = this.resolveBase()
    const worktreePath = computeWorktreePath({
      base,
      newBranch: req.newBranch,
      taskId: req.taskId
    })

    const args = [
      '-C',
      req.repoDir,
      'worktree',
      'add',
      '-b',
      req.newBranch,
      worktreePath,
      req.sourceBranch
    ]

    const result = await this.runner.run(GIT, args, {
      cwd: req.repoDir,
      env: scriptEnv(req.taskId, req.repoDir),
      timeoutMs: settings.worktreeCreateTimeoutMs,
      onStderrLine: onProgress
    })

    if (result.timedOut) {
      throw new Error(`git worktree add timed out (${worktreePath})`)
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree add failed (exit ${result.exitCode ?? result.signal}): ${firstLine(result.stderr)}`
      )
    }

    // Git created the path we chose; validate it the same way as a script's path.
    const validation = validateWorktreePath(worktreePath, this.probe)
    if (!validation.ok) {
      throw new Error(validation.error)
    }
    if (validation.warning) {
      this.onWarning?.(validation.warning)
    }

    return { path: worktreePath, script: GIT, args }
  }

  async adopt(req: AdoptWorktreeRequest): Promise<AdoptWorktreeResult> {
    // Validate the picked directory the same way as a created path (absolute,
    // exists, is a dir; a missing `.git` is a non-fatal warning, §6.4).
    const validation = validateWorktreePath(req.worktreeDir, this.probe)
    if (!validation.ok) {
      throw new Error(validation.error)
    }
    if (validation.warning) {
      this.onWarning?.(validation.warning)
    }

    const env = scriptEnv(req.taskId, req.worktreeDir)

    // The FIRST record of the porcelain listing is always the main worktree (or,
    // for a bare repo, the bare directory itself) — its path is the repo root we
    // store for delete safety (§6.4). `parseMainWorktree` returns it unfiltered,
    // deliberately not routed through the bare/prunable-filtering
    // `parseWorktreeList`.
    const list = await this.runner.run(
      GIT,
      ['-C', req.worktreeDir, 'worktree', 'list', '--porcelain'],
      {
        cwd: req.worktreeDir,
        env
      }
    )
    if (list.exitCode !== 0) {
      throw new Error(`not a git worktree: ${req.worktreeDir} (${firstLine(list.stderr)})`)
    }
    const repoRoot = parseMainWorktree(list.stdout)
    if (!repoRoot) {
      throw new Error(`could not determine the repo root for: ${req.worktreeDir}`)
    }

    // The repo's MAIN working tree is allowed here (repoRoot === path): an adopted
    // task is `managed === false`, so `deleteTask` never calls `remove` and thus
    // `assertSafeToDelete`'s candidate===repoRoot refusal is never reached — the
    // directory is simply left on disk when the task is deleted (§6.4).

    // Detect the current branch; `HEAD` means detached → no branch.
    const head = await this.runner.run(
      GIT,
      ['-C', req.worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      {
        cwd: req.worktreeDir,
        env
      }
    )
    const headRef = firstNonEmptyLine(head.stdout).trim()
    const branch = head.exitCode === 0 && headRef !== '' && headRef !== 'HEAD' ? headRef : undefined

    return { path: canonPath(req.worktreeDir), repoRoot: canonPath(repoRoot), branch }
  }

  async remove(req: RemoveWorktreeRequest): Promise<void> {
    // Containment check BEFORE git runs (§6.4). Throws on any doubt.
    assertSafeToDelete({
      candidate: req.path,
      storedPath: req.path,
      repoRoot: req.repoDir
    })

    // `--force` only when the user confirmed a dirty delete: git refuses to remove
    // a worktree with uncommitted changes otherwise, which would strand the task
    // in DeleteFailed after the user already chose to delete it (§6.4).
    const args = ['-C', req.repoDir, 'worktree', 'remove', req.path]
    if (req.confirmedDirty === true) {
      args.push('--force')
    }

    // Resolve regardless of exit code (I4); spawn failure (ENOENT) still rejects.
    await this.runner.run(GIT, args, {
      cwd: req.repoDir,
      env: scriptEnv(req.taskId, req.repoDir)
    })
  }

  isDirty(worktreePath: string): Promise<boolean> {
    return gitIsDirty(this.runner, worktreePath)
  }

  async inspectRepo(dir: string): Promise<InspectRepoResult> {
    // A missing dir would surface as `spawn git ENOENT`, which reads as "git
    // isn't installed" — check first and give an accurate error.
    if (!this.probe.isDirectory(dir)) {
      throw new Error(`project directory not found: ${dir}`)
    }

    const list = await this.runner.run(GIT, ['-C', dir, 'worktree', 'list', '--porcelain'], {
      cwd: dir,
      timeoutMs: INSPECT_TIMEOUT_MS
    })
    if (list.timedOut) {
      throw new Error(`git worktree list timed out: ${dir}`)
    }
    const mainPath = parseMainWorktree(list.stdout)
    if (list.exitCode !== 0 || !mainPath) {
      throw new Error(`not a git repository: ${dir} (${firstLine(list.stderr)})`)
    }
    const root = canonPath(mainPath)

    // Default branch: `origin/HEAD` (prefix stripped) first; else the current
    // branch, ignoring a detached HEAD; else undefined (§6.4). Uses the FULL ref
    // name (no `--short`) so stripping the literal `refs/remotes/origin/` prefix
    // can't be fooled by a LOCAL branch that happens to be named `origin/<b>` —
    // `--short` would print `remotes/origin/<b>` in that case.
    let defaultBranch: string | undefined
    const symbolic = await this.runner.run(
      GIT,
      ['-C', root, 'symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd: root, timeoutMs: INSPECT_TIMEOUT_MS }
    )
    if (symbolic.exitCode === 0 && !symbolic.timedOut) {
      const value = firstNonEmptyLine(symbolic.stdout).trim()
      const prefix = 'refs/remotes/origin/'
      if (value.startsWith(prefix)) {
        const branch = value.slice(prefix.length)
        if (branch !== '') {
          defaultBranch = branch
        }
      }
    }
    if (defaultBranch === undefined) {
      const head = await this.runner.run(GIT, ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: root,
        timeoutMs: INSPECT_TIMEOUT_MS
      })
      if (head.exitCode === 0 && !head.timedOut) {
        const value = firstNonEmptyLine(head.stdout).trim()
        if (value !== '' && value !== 'HEAD') {
          defaultBranch = value
        }
      }
    }

    return { root, defaultBranch }
  }

  async listWorktrees(root: string): Promise<readonly RepoWorktree[]> {
    if (!this.probe.isDirectory(root)) {
      throw new Error(`project directory not found: ${root}`)
    }

    const list = await this.runner.run(GIT, ['-C', root, 'worktree', 'list', '--porcelain'], {
      cwd: root,
      timeoutMs: INSPECT_TIMEOUT_MS
    })
    if (list.timedOut) {
      throw new Error(`git worktree list timed out: ${root}`)
    }
    if (list.exitCode !== 0) {
      throw new Error(
        `git worktree list failed (exit ${list.exitCode ?? list.signal}): ${firstLine(list.stderr)}`
      )
    }
    return parseWorktreeList(list.stdout).map((w) => ({ ...w, path: canonPath(w.path) }))
  }
}
