/**
 * The daemon's live-PTY table (DESIGN §6.2): `Map<sessionId, DaemonPty>`. This is
 * the ONLY daemon file that imports the native node-pty module as a value
 * (mirroring how `pty-session-manager.ts` localizes it on the in-process side);
 * everything else works against the injected {@link DaemonPtySpawn}, so the
 * registry + `DaemonPty` stay unit-testable with a fake spawn.
 *
 * Sessions are keyed by the domain `SessionId` string the client supplies on
 * `spawn` (I5: globally unique, needs no task context) — there is no separate
 * handle table. The registry also resolves each PTY's current cwd from
 * `/proc/<pid>/cwd` for the `listSessions` roster (§6.2, Linux VDI target).
 */

import * as pty from 'node-pty'
import { readlinkSync } from 'node:fs'
import { buildPtyEnv } from '../shared/pty-env'
import type { DaemonSessionInfo, SpawnParams } from '../shared/node/daemon-protocol'
import { DaemonPty, type DaemonPtySink, type DaemonPtySpawn } from './daemon-pty'

/** node-pty's spawn narrowed to the daemon's contract (structural match). */
const nodePtySpawn = pty.spawn as unknown as DaemonPtySpawn

export interface PtyRegistryOptions {
  /** Override the native spawn (tests inject a fake). */
  readonly spawn?: DaemonPtySpawn
  /** Server-side ring-buffer cap per session (default ~5 MB). */
  readonly bufferBytes?: number
  /** cwd resolver (default reads /proc/<pid>/cwd); injectable for tests/portability. */
  readonly resolveCwd?: (pid: number) => string | undefined
}

/** Best-effort cwd of a pid via /proc (Linux). Undefined if unresolvable. */
function procCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return undefined
  }
}

export class PtyRegistry {
  private readonly spawn: DaemonPtySpawn
  private readonly bufferBytes?: number
  private readonly resolveCwd: (pid: number) => string | undefined
  private readonly ptys = new Map<string, DaemonPty>()

  constructor(opts: PtyRegistryOptions = {}) {
    this.spawn = opts.spawn ?? nodePtySpawn
    this.bufferBytes = opts.bufferBytes
    this.resolveCwd = opts.resolveCwd ?? procCwd
  }

  has(sessionId: string): boolean {
    return this.ptys.has(sessionId)
  }

  get(sessionId: string): DaemonPty | undefined {
    return this.ptys.get(sessionId)
  }

  /**
   * Spawn a fresh PTY for `sessionId`. Throws if one already exists (the client
   * must `attach`, not re-`spawn`). Builds the child env daemon-side from its own
   * `process.env` (the correct base for a long-lived host) plus the OCTOPUS_* vars.
   */
  spawnSession(params: SpawnParams): DaemonPty {
    if (this.ptys.has(params.sessionId)) {
      throw new Error(`session ${params.sessionId} already exists`)
    }
    const env = buildPtyEnv(process.env, {
      taskId: params.taskId,
      sessionId: params.sessionId,
      worktreePath: params.cwd,
      stateSocketPath: params.stateSocketPath
    })
    const dpty = new DaemonPty({
      spawn: this.spawn,
      shell: params.shell,
      args: params.args,
      cwd: params.cwd,
      cols: params.cols,
      rows: params.rows,
      env,
      bufferBytes: this.bufferBytes
    })
    this.ptys.set(params.sessionId, dpty)
    return dpty
  }

  attach(sessionId: string, sink: DaemonPtySink): boolean | undefined {
    const dpty = this.ptys.get(sessionId)
    if (!dpty) {
      return undefined
    }
    return dpty.attach(sink)
  }

  /** Close (SIGHUP→grace→SIGKILL) and forget a session. Resolves when dead. */
  async close(sessionId: string): Promise<void> {
    const dpty = this.ptys.get(sessionId)
    if (!dpty) {
      return
    }
    await dpty.close()
    this.ptys.delete(sessionId)
  }

  /** Drop a session record after its spontaneous exit (already dead). */
  forget(sessionId: string): void {
    this.ptys.delete(sessionId)
  }

  /** How many sessions are tracked (live or awaiting cleanup). */
  get size(): number {
    return this.ptys.size
  }

  /** The re-attach roster (§6.2): one entry per tracked session, with current cwd. */
  list(): DaemonSessionInfo[] {
    const out: DaemonSessionInfo[] = []
    for (const [sessionId, dpty] of this.ptys) {
      out.push({
        sessionId,
        alive: dpty.alive,
        pid: dpty.pid,
        cwd: dpty.alive ? this.resolveCwd(dpty.pid) : undefined,
        cols: dpty.currentCols,
        rows: dpty.currentRows
      })
    }
    return out
  }

  /** All tracked session ids (for orphan reconciliation on the client side). */
  ids(): string[] {
    return [...this.ptys.keys()]
  }
}
