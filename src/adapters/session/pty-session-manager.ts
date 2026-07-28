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

export interface PtySessionManagerDeps {
  /** Live settings accessor (for `terminal.shell`). */
  readonly getSettings: () => Settings
  /** Inherited env to sanitize into the child (defaults to `process.env`). */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>
  /** SIGHUP→SIGKILL grace period override (ms). */
  readonly graceMs?: number
}

/** node-pty's spawn narrowed to the runtime's contract (structural match). */
const nodePtySpawn = pty.spawn as unknown as PtySpawn

export class PtySessionManager implements SessionManager {
  private readonly getSettings: () => Settings
  private readonly graceMs?: number

  constructor(deps: PtySessionManagerDeps) {
    this.getSettings = deps.getSettings
    this.graceMs = deps.graceMs
  }

  createRuntime(ctx: SessionRuntimeContext): SessionRuntime {
    const settings = this.getSettings()
    const shell = resolveShell(ctx.shell, settings.terminal.shell, process.env.SHELL)
    return new PtyTerminalRuntime(ctx, {
      spawn: nodePtySpawn,
      shell,
      graceMs: this.graceMs
    })
  }
}
