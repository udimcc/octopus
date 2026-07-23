/**
 * Headless PTY integration (DESIGN §6.1). Drives the REAL node-pty-backed
 * `PtySessionManager` — the same adapter the composition root wires — end to end:
 * spawn a shell at a chosen cwd, observe batched output over `ctx.onData`, write a
 * command and read its result back, resize, and see `ctx.onExit` fire when the
 * shell exits. This is the backend half of the M4 gate ("createSession →
 * writeToPty → observe ptyData") exercised against a live process, not a fake PTY.
 *
 * Skipped (not failed) if node-pty cannot be loaded/spawned in this environment,
 * so the suite stays green on a box without the native binary. The probe runs
 * synchronously at module load — `describe`/`it` are collected before any hook —
 * so the skip decision is made at collection time (mirrors the worktree suite's
 * `git --version` guard).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionManager, SessionRuntime, SessionRuntimeContext } from '../../src/ports/session-runtime'
import type { Settings } from '../../src/ports/settings-store'
import { PtySessionManager } from '../../src/adapters/session/pty-session-manager'
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
  defaultSessionTypeId: 'terminal'
}

d('PtySessionManager (integration, §6.1)', () => {
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

  function freshCwd(): void {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-pty-')))
  }

  interface Live {
    runtime: SessionRuntime
    output: () => string
    exit: Promise<{ code?: number; signal?: number }>
  }

  /** Spawn a live runtime, accumulating batched output and capturing the exit. */
  function spawnRuntime(overrides: Partial<SessionRuntimeContext> = {}): Live {
    const manager: SessionManager = new PtySessionManager({
      getSettings: () => SETTINGS,
      graceMs: 500
    })
    let buf = ''
    let resolveExit!: (e: { code?: number; signal?: number }) => void
    const exit = new Promise<{ code?: number; signal?: number }>((r) => (resolveExit = r))
    const ctx: SessionRuntimeContext = {
      taskId: asTaskId('t1'),
      sessionId: asSessionId('s1'),
      worktreePath: cwd,
      cols: 80,
      rows: 24,
      env: process.env,
      onData: (data) => {
        buf += data
      },
      onExit: (code, signal) => resolveExit({ code, signal }),
      ...overrides
    }
    const runtime = manager.createRuntime(ctx)
    runtimes.push(runtime)
    return { runtime, output: () => buf, exit }
  }

  /** Poll until `pred(output)` holds or the timeout elapses. */
  async function waitFor(
    output: () => string,
    pred: (s: string) => boolean,
    ms = 4000
  ): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (pred(output())) return output()
      await new Promise((r) => setTimeout(r, 20))
    }
    return output()
  }

  it('spawns a shell at the worktree cwd and echoes a command back', async () => {
    freshCwd()
    const live = spawnRuntime()
    await live.runtime.start()

    // A command whose output we can unambiguously recognize in the stream.
    live.runtime.write('echo OCTOPUS_MARKER_$((6*7))\n')
    const out = await waitFor(live.output, (s) => /OCTOPUS_MARKER_42/.test(s))
    expect(out).toMatch(/OCTOPUS_MARKER_42/)

    // pwd resolves to the cwd we spawned at (login shell may print more; just contain).
    live.runtime.write('pwd\n')
    const out2 = await waitFor(live.output, (s) => s.includes(cwd))
    expect(out2).toContain(cwd)
  })

  it('forwards a resize without error while the shell is live', async () => {
    freshCwd()
    const live = spawnRuntime()
    await live.runtime.start()
    expect(() => live.runtime.resize(120, 40)).not.toThrow()
    // The shell keeps working after the resize.
    live.runtime.write('echo AFTER_RESIZE\n')
    const out = await waitFor(live.output, (s) => s.includes('AFTER_RESIZE'))
    expect(out).toContain('AFTER_RESIZE')
  })

  it('fires onExit with the shell exit code when the shell exits on its own', async () => {
    freshCwd()
    const live = spawnRuntime()
    await live.runtime.start()
    live.runtime.write('exit 3\n')
    const e = await live.exit
    // The shell propagates its own exit code (3) through node-pty.
    expect(e.code).toBe(3)
  })

  it('stop() terminates a live shell and resolves (SIGHUP → grace → SIGKILL)', async () => {
    freshCwd()
    const live = spawnRuntime()
    await live.runtime.start()
    // Start something that would otherwise sit forever, then stop.
    live.runtime.write('sleep 60\n')
    await new Promise((r) => setTimeout(r, 100))
    // A user stop suppresses ctx.onExit (close-session owns Stopping → Closed),
    // so we assert on stop() resolving, not on the exit promise firing.
    await expect(live.runtime.stop()).resolves.toBeUndefined()
  })
})
