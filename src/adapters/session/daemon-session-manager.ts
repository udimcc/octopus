/**
 * `SessionManager` backed by the `octopusd` daemon (DESIGN §6.2, §8) — the durable
 * drop-in for `PtySessionManager`. Selected at the composition root when
 * `settings.terminal.backend === 'daemon'`; the port seam means swapping it swaps
 * the ENTIRE backend with no renderer or use-case change (§10).
 *
 * It owns the single long-lived {@link DaemonClient} (one connection per app,
 * shared by every session) and, per `createRuntime`, resolves the shell main-side
 * (`resolveShell` needs live settings) and hands a {@link DaemonSessionRuntime} the
 * client + shell. Shell resolution stays here, exactly as in `PtySessionManager`;
 * the daemon receives the already-resolved shell in `spawn`.
 *
 * The client is created but NOT connected here — `DaemonSessionRuntime.start()`
 * calls `client.ensureReady()`, which connects-or-launches. The composition root
 * separately calls `ensureReady()` + `listSessions()` at bootstrap to build the
 * re-attach roster (`liveDaemonSessions`).
 */

import type {
  SessionManager,
  SessionRuntime,
  SessionRuntimeContext
} from '../../ports/session-runtime'
import type { Settings } from '../../ports/settings-store'
import { resolveShell } from '../../shared/pty-env'
import { shellSpawnPlan, type ShellIntegrationFiles } from '../../shared/node/shell-integration'
import { DaemonClient } from './daemon-client'
import { DaemonSessionRuntime } from './daemon-session-runtime'

export interface DaemonSessionManagerDeps {
  /** The shared daemon connection (built at the composition root). */
  readonly client: DaemonClient
  /** Live settings accessor (for `terminal.shell`). */
  readonly getSettings: () => Settings
  /**
   * Generated OSC 133 shell-integration files (§12.1), shared with the in-process
   * manager. When present AND state detection is on, bash/zsh spawn against them (the
   * `envPatch`/`args` ride to the daemon in `spawn`); omitted ⇒ plain login shells.
   */
  readonly shellIntegration?: ShellIntegrationFiles
}

export class DaemonSessionManager implements SessionManager {
  private readonly client: DaemonClient
  private readonly getSettings: () => Settings
  private readonly shellIntegration?: ShellIntegrationFiles

  constructor(deps: DaemonSessionManagerDeps) {
    this.client = deps.client
    this.getSettings = deps.getSettings
    this.shellIntegration = deps.shellIntegration
  }

  createRuntime(ctx: SessionRuntimeContext): SessionRuntime {
    const settings = this.getSettings()
    const shell = resolveShell(ctx.shell, settings.terminal.shell, process.env.SHELL)
    // State detection on unless explicitly opted out (§9). The daemon still runs its
    // (cheap) evaluator regardless; when off, the runtime simply doesn't surface a
    // state evaluator, so `startSessionRuntime` never subscribes and no icons show.
    const stateDetection = settings.terminal.stateDetection !== false
    // OSC 133 injection rides the same opt-out and only applies to the default
    // interactive login shell (a custom ctx.shell skips it, §12.1). The daemon builds
    // the child env from ITS process.env, so we forward only the integration delta as
    // `envPatch`; HOME/ZDOTDIR are read here from the app's env (same user).
    const plan =
      stateDetection && this.shellIntegration && ctx.shell === undefined
        ? shellSpawnPlan(shell, this.shellIntegration, process.env)
        : undefined
    return new DaemonSessionRuntime(ctx, {
      client: this.client,
      shell,
      args: plan?.args,
      envPatch: plan?.envPatch,
      stateDetection
    })
  }
}
