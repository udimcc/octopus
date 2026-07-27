/**
 * `WorktreeRef` value object (DESIGN §3.2). Immutable after provisioning (I2):
 * re-pointing would break the cwd of running sessions. Provisioning *status*
 * lives in `TaskLifecycle`, not here — this object only exists once a task is
 * `Ready`, and it records where the worktree is and how it was created.
 *
 * Octopus is location- and repo-agnostic (§6.4, §12.4): the create script owns
 * the path and returns it verbatim; `branch`/`baseRef` may be unknown.
 */

/** Provenance of a script-provisioned worktree (§3.2, §6.4). */
export interface ScriptInvocationMeta {
  /** The script command that produced this worktree. */
  readonly script: string
  /** Arguments passed (argv, never a shell string — I17). */
  readonly args: readonly string[]
  /** The directory Octopus was launched in, passed to the script as a hint (§12.4). */
  readonly repoRoot: string
  /** When the create script completed (epoch ms). */
  readonly provisionedAt: number
}

export interface WorktreeRefProps {
  /** Absolute path returned by the create script, stored verbatim (§6.4). */
  path: string
  /** Branch requested at creation, if any (§12.3). */
  branch?: string
  /** Base ref the worktree was created from, if known. */
  baseRef?: string
  provisionedBy: ScriptInvocationMeta
}

export class WorktreeRef {
  readonly path: string
  readonly branch?: string
  readonly baseRef?: string
  readonly provisionedBy: ScriptInvocationMeta

  private constructor(props: WorktreeRefProps) {
    this.path = props.path
    this.branch = props.branch
    this.baseRef = props.baseRef
    // Freeze the invocation meta (incl. its args array) so the whole value
    // object is deeply immutable (I2).
    this.provisionedBy = Object.freeze({
      ...props.provisionedBy,
      args: Object.freeze([...props.provisionedBy.args]) as readonly string[]
    })
    Object.freeze(this)
  }

  /**
   * Construct a validated, frozen `WorktreeRef`. The path must be absolute; the
   * caller (application) is responsible for the fuller filesystem validation
   * (exists, is a directory) since the domain performs no I/O.
   */
  static create(props: WorktreeRefProps): WorktreeRef {
    return new WorktreeRef(props)
  }
}
