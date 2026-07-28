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
import { DaemonClient } from './daemon-client'
import { DaemonSessionRuntime } from './daemon-session-runtime'

export interface DaemonSessionManagerDeps {
  /** The shared daemon connection (built at the composition root). */
  readonly client: DaemonClient
  /** Live settings accessor (for `terminal.shell`). */
  readonly getSettings: () => Settings
}

export class DaemonSessionManager implements SessionManager {
  private readonly client: DaemonClient
  private readonly getSettings: () => Settings

  constructor(deps: DaemonSessionManagerDeps) {
    this.client = deps.client
    this.getSettings = deps.getSettings
  }

  createRuntime(ctx: SessionRuntimeContext): SessionRuntime {
    const settings = this.getSettings()
    const shell = resolveShell(ctx.shell, settings.terminal.shell, process.env.SHELL)
    return new DaemonSessionRuntime(ctx, { client: this.client, shell })
  }
}
