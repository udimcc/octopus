/**
 * `SessionManager` backed by node-pty (DESIGN §6.1, §8). This is the ONLY file
 * that imports the native node-pty module as a value; everything else works
 * against the injected {@link PtySpawn} in `pty-terminal-runtime.ts`, so the
 * runtime logic stays unit-testable with a fake PTY.
 *
 * `createRuntime` resolves the shell (ctx override → `settings.terminal.shell` →
 * `$SHELL` → `/bin/bash`, §6.1) and hands a narrow `spawn` to a
 * {@link PtyTerminalRuntime}. node-pty's `spawn`/`IPty` structurally satisfy the
 * runtime's `PtySpawn`/`PtyProcess` slices; the small cast localizes that here.
 */

import * as pty from 'node-pty'
import type { SessionManager, SessionRuntime, SessionRuntimeContext } from '../../ports/session-runtime'
import type { Settings } from '../../ports/settings-store'
import { PtyTerminalRuntime, type PtySpawn } from './pty-terminal-runtime'
import { resolveShell } from '../../shared/pty-env'
import { shellSpawnPlan, type ShellIntegrationFiles } from '../../shared/node/shell-integration'
import type { ProgramStateDetectorRegistry } from '../../shared/node/state/state-core'

export interface PtySessionManagerDeps {
  /** Live settings accessor (for `terminal.shell`). */
  readonly getSettings: () => Settings
  /** Inherited env to sanitize into the child (defaults to `process.env`). */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>
  /** SIGHUP→SIGKILL grace period override (ms). */
  readonly graceMs?: number
  /**
   * Pluggable per-program state detectors (§9.3). Passed to each runtime so it can
   * evaluate state; gated per-`createRuntime` by `terminal.stateDetection` so the
   * opt-out cleanly yields no evaluator. Omitted ⇒ detection off everywhere.
   */
  readonly detectorRegistry?: ProgramStateDetectorRegistry
  /**
   * Generated OSC 133 shell-integration files (§12.1). When present AND state
   * detection is on, bash/zsh are launched against them so Waiting/Working icons
   * work out of the box; omitted ⇒ plain login shells (no injection).
   */
  readonly shellIntegration?: ShellIntegrationFiles
}

/** node-pty's spawn narrowed to the runtime's contract (structural match). */
const nodePtySpawn = pty.spawn as unknown as PtySpawn

export class PtySessionManager implements SessionManager {
  private readonly getSettings: () => Settings
  private readonly graceMs?: number
  private readonly detectorRegistry?: ProgramStateDetectorRegistry
  private readonly shellIntegration?: ShellIntegrationFiles

  constructor(deps: PtySessionManagerDeps) {
    this.getSettings = deps.getSettings
    this.graceMs = deps.graceMs
    this.detectorRegistry = deps.detectorRegistry
    this.shellIntegration = deps.shellIntegration
  }

  createRuntime(ctx: SessionRuntimeContext): SessionRuntime {
    const settings = this.getSettings()
    const shell = resolveShell(ctx.shell, settings.terminal.shell, process.env.SHELL)
    // State detection is on unless explicitly opted out (§9). When off, pass no
    // registry so the runtime builds no evaluator (no /proc polling, no socket).
    const detection = settings.terminal.stateDetection !== false
    const detectorRegistry = detection ? this.detectorRegistry : undefined
    // OSC 133 injection rides the same opt-out (§12.1): a custom ctx.shell arg (e.g.
    // `-c` from a scripted session) also skips it — integration only applies to the
    // default interactive login shell. `shellSpawnPlan` returns the login default for
    // any non-bash/zsh shell, so this is safe for every shell.
    const plan =
      detection && this.shellIntegration && ctx.shell === undefined
        ? shellSpawnPlan(shell, this.shellIntegration, ctx.env)
        : undefined
    return new PtyTerminalRuntime(ctx, {
      spawn: nodePtySpawn,
      shell,
      args: plan?.args,
      envPatch: plan?.envPatch,
      graceMs: this.graceMs,
      detectorRegistry
    })
  }
}
