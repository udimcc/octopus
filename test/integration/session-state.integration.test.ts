/**
 * Headless session-state integration (DESIGN §9, §9.6, Phase 2 test matrix). Drives
 * the REAL node-pty-backed `PtyTerminalRuntime` end to end with the pluggable
 * detector registry wired — the same fusion the composition root builds — and asserts
 * the Claude-only model (§9) actually moves a live session's `SessionState`:
 *
 *   - **Structural sentinel (§9.1):** a plain foreground child (`sleep`) with NO
 *     explicit signal stays `Unknown` — status is Claude-only, a bare terminal never
 *     lights up. This is `tcgetpgrp`/`/proc` on the real fd.
 *   - **L3 explicit (§9.2):** a direct write to the per-session `$OCTOPUS_STATE_SOCKET`
 *     with `{"state":"blocked",…}` WHILE a child holds the foreground → `Blocked`
 *     (Needs input), authoritative + immediate; it sticks until the shell returns to
 *     its prompt.
 *
 * These are the in-process backend standing in for the daemon (both host the identical
 * `CompositeStateProvider`, §9.6).
 *
 * Skipped (not failed) if node-pty can't spawn here, matching the sibling PTY suite so
 * the run stays green on a box without the native binary.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import type {
  SessionManager,
  SessionRuntime,
  SessionRuntimeContext,
  StateChangeMeta
} from '../../src/ports/session-runtime'
import type { Settings } from '../../src/ports/settings-store'
import { PtySessionManager } from '../../src/adapters/session/pty-session-manager'
import { createDefaultDetectorRegistry } from '../../src/shared/node/state/state-core'
import { SessionState } from '../../src/domain/state'
import { asTaskId, asSessionId } from '../../src/domain/ids'

// Synchronous probe at collection time: can we load node-pty AND spawn a child?
const ptyOk = ((): boolean => {
  try {
    const require = createRequire(import.meta.url)
    const pty = require('node-pty') as typeof import('node-pty')
    const probe = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 80, rows: 24 })
    probe.kill()
    return true
  } catch {
    return false
  }
})()

const d = ptyOk ? describe : describe.skip

const SETTINGS: Settings = {
  worktree: { location: '/octopus_repos' },
  terminal: { shell: '/bin/bash' },
  defaultSessionTypeId: 'terminal',
  groupTasksByRepo: true
}

d('session state detection (integration, §9)', () => {
  let cwd = ''
  const runtimes: SessionRuntime[] = []

  afterEach(() => {
    for (const rt of runtimes.splice(0)) {
      rt.dispose()
    }
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true })
      cwd = ''
    }
  })

  interface Live {
    runtime: SessionRuntime
    states: Array<{ state: SessionState; meta?: StateChangeMeta }>
    socketPath: string
  }

  /** Spawn a live runtime with detection wired, subscribing to state changes. */
  function spawnRuntime(): Live {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-state-')))
    const socketPath = join(cwd, 'state.sock')
    const manager: SessionManager = new PtySessionManager({
      getSettings: () => SETTINGS,
      graceMs: 500,
      detectorRegistry: createDefaultDetectorRegistry()
    })
    const ctx: SessionRuntimeContext = {
      taskId: asTaskId('t1'),
      sessionId: asSessionId('s1'),
      worktreePath: cwd,
      cols: 80,
      rows: 24,
      env: process.env,
      // The default interactive shell (no ctx.shell / `-c`); the L2 tpgid/proc
      // heuristic asserted here works regardless of OSC 133 injection.
      stateSocketPath: socketPath,
      onData: () => {},
      onExit: () => {}
    }
    const runtime = manager.createRuntime(ctx)
    runtimes.push(runtime)
    return { runtime, states: [], socketPath }
  }

  /** Subscribe to state changes — call AFTER `start()`, which builds the evaluator. */
  function subscribe(live: Live): void {
    const ev = live.runtime.stateEvaluator()
    if (!ev) {
      throw new Error('no state evaluator after start (detection should be on)')
    }
    ev.onStateChange((state, meta) => live.states.push({ state, meta }))
  }

  /** Poll until `pred()` holds or the timeout elapses (no wall-clock assertions). */
  async function waitUntil(pred: () => boolean, ms = 6000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (pred()) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return pred()
  }

  const last = (live: Live): SessionState | undefined =>
    live.states[live.states.length - 1]?.state

  /** Write one newline-delimited JSON frame to the session's L3 socket. */
  async function writeSocket(live: Live, frame: object): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const conn = connect(live.socketPath)
      conn.on('error', reject)
      conn.on('connect', () => {
        conn.write(JSON.stringify(frame) + '\n')
        conn.end(resolve)
      })
    })
  }

  it('a plain foreground child (sleep) with no explicit signal stays Unknown (Claude-only, §9)', async () => {
    const live = spawnRuntime()
    await live.runtime.start()
    subscribe(live)

    // A foreground child holds the terminal, but nothing reports its state: status is
    // Claude-only, so a bare terminal never leaves Unknown (no icon).
    live.runtime.write('sleep 2\n')
    // Give the structural poll several cycles; assert it NEVER emitted a lit state.
    await new Promise((r) => setTimeout(r, 1500))
    expect(live.states.every((s) => s.state === SessionState.Unknown)).toBe(true)
  }, 20000)

  it('a socket write while a child holds the foreground flips to Blocked, sticky until the prompt', async () => {
    const live = spawnRuntime()
    await live.runtime.start()
    subscribe(live)
    await new Promise((r) => setTimeout(r, 200)) // let the socket listener bind

    // Hold the foreground with a long-lived child so the explicit signal is not
    // dropped by the at-prompt sentinel (the tradeoff in §9.1).
    live.runtime.write('sleep 30\n')
    await new Promise((r) => setTimeout(r, 400))

    await writeSocket(live, { state: 'blocked', reason: 'permission_request' })

    const sawBlocked = await waitUntil(() => last(live) === SessionState.NeedsInput)
    expect(sawBlocked).toBe(true)
    // Explicit L3 is authoritative and immediate (§9.1).
    const blocked = live.states.filter((s) => s.state === SessionState.NeedsInput).pop()
    expect(blocked?.meta?.layer).toBe(3)

    // It sticks across poll ticks while the child runs — no flapping (bug 2.2).
    await new Promise((r) => setTimeout(r, 800))
    expect(last(live)).toBe(SessionState.NeedsInput)

    // Kill the child so the shell returns to its prompt → the tracked program is gone
    // → Unknown (the sticky explicit is cleared).
    live.runtime.write('\x03') // Ctrl-C interrupts the sleep
    const clearedToUnknown = await waitUntil(() => last(live) === SessionState.Unknown, 8000)
    expect(clearedToUnknown).toBe(true)
  }, 20000)
})
