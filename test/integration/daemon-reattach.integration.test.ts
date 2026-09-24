/**
 * Durable-session re-attach integration (DESIGN §6.2) — the core proof that the
 * `octopusd` backend survives an app restart. It drives the WHOLE daemon stack end
 * to end against a REAL Unix socket and REAL node-pty: a `DaemonServer` +
 * `PtyRegistry` on one side, the app's `DaemonClient` on the other.
 *
 * The "app restart" is simulated by DISPOSING the client (dropping the socket, which
 * the server reads as detach-all — the PTY keeps running) and then creating a FRESH
 * client that reconnects to the same socket, `listSessions` (roster shows the shell
 * alive with its post-`cd` cwd), and `attach` (the replayed ring buffer contains the
 * output printed before the "restart"). That is exactly the two reported bugs fixed:
 * the shell keeps its cwd and its scrollback across the app going away.
 *
 * Runs on HOST NODE (no Electron/display): node-pty is N-API/ABI-stable, so the same
 * module the daemon uses loads here. Skipped (not failed) if node-pty can't spawn, so
 * the suite stays green on a box without the native binary — mirroring
 * `pty.integration.test.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from '../../src/daemon/server'
import { PtyRegistry } from '../../src/daemon/pty-registry'
import { DaemonClient, type DaemonSessionSink } from '../../src/adapters/session/daemon-client'

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

/** A recording sink whose accumulated output the test can poll. */
function recordingSink(): DaemonSessionSink & { text: () => string; exits: number[] } {
  let buf = ''
  const exits: number[] = []
  return {
    onData: (data) => {
      buf += data
    },
    onExit: (code) => {
      exits.push(code)
    },
    text: () => buf,
    exits
  }
}

async function waitFor(
  get: () => string,
  pred: (s: string) => boolean,
  ms = 4000
): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred(get())) return get()
    await new Promise((r) => setTimeout(r, 20))
  }
  return get()
}

d('octopusd re-attach (integration, §6.2)', () => {
  let dir = ''
  let server: DaemonServer | null = null
  const clients: DaemonClient[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      c.dispose()
    }
    if (server) {
      await server.close()
      server = null
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  /** Start a real DaemonServer bound to a fresh per-test socket; return its path. */
  async function startServer(): Promise<{ socketPath: string; registry: PtyRegistry }> {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-daemon-')))
    const socketPath = join(dir, 'octopusd.sock')
    const registry = new PtyRegistry()
    server = new DaemonServer({ registry, socketPath, daemonVersion: 'test' })
    await server.listen()
    return { socketPath, registry }
  }

  /**
   * A client that connects to the already-running server. `launchFn` returns true
   * without doing anything (the server is up; connect succeeds on the first try),
   * so no real process is spawned.
   */
  function makeClient(socketPath: string): DaemonClient {
    const client = new DaemonClient({
      socketPath,
      daemonEntry: '/nonexistent/daemon.js',
      launchFn: () => true
    })
    clients.push(client)
    return client
  }

  it('re-attaches a live shell across an app restart, replaying its scrollback and cwd', async () => {
    const { socketPath } = await startServer()
    const sessionId = 'sess-reattach'

    // --- App instance #1: spawn a shell, cd into a subdir, print a marker. ---
    const workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-wt-')))
    const client1 = makeClient(socketPath)
    await client1.ensureReady()
    const sink1 = recordingSink()
    client1.registerSink(sessionId, sink1)
    const pid = await client1.spawn({
      sessionId,
      taskId: 'task-1',
      shell: '/bin/bash',
      args: ['--norc', '--noprofile', '-i'],
      cwd: workRoot,
      cols: 80,
      rows: 24
    })
    expect(pid).toBeGreaterThan(0)

    // Create a subdir, cd into it, and print a unique marker we can find in replay.
    client1.write(sessionId, 'mkdir -p sub && cd sub\n')
    client1.write(sessionId, 'echo OCTOPUS_BEFORE_RESTART_$((6*7))\n')
    await waitFor(sink1.text, (s) => /OCTOPUS_BEFORE_RESTART_42/.test(s))
    expect(sink1.text()).toMatch(/OCTOPUS_BEFORE_RESTART_42/)

    // --- Simulate the app quitting: drop the client (server keeps the PTY). ---
    client1.dispose()
    // Give the server a moment to process the disconnect (detach-all, not close).
    await new Promise((r) => setTimeout(r, 50))

    // --- App instance #2: reconnect, list the roster, re-attach. ---
    const client2 = makeClient(socketPath)
    await client2.ensureReady()

    const roster = await client2.listSessions()
    const entry = roster.find((s) => s.sessionId === sessionId)
    expect(entry).toBeDefined()
    expect(entry!.alive).toBe(true)
    // The shell kept its cwd across the "restart": /proc/<pid>/cwd is the subdir.
    expect(entry!.cwd).toBe(join(workRoot, 'sub'))

    // Attach: the daemon replays its ring buffer, so the pre-restart marker is back.
    const sink2 = recordingSink()
    client2.registerSink(sessionId, sink2)
    const alive = await client2.attach(sessionId)
    expect(alive).toBe(true)
    const replay = await waitFor(sink2.text, (s) => /OCTOPUS_BEFORE_RESTART_42/.test(s))
    expect(replay).toMatch(/OCTOPUS_BEFORE_RESTART_42/)

    // The re-attached shell is still LIVE: a new command echoes back on sink2.
    client2.write(sessionId, 'echo OCTOPUS_AFTER_RESTART\n')
    const live = await waitFor(sink2.text, (s) => s.includes('OCTOPUS_AFTER_RESTART'))
    expect(live).toContain('OCTOPUS_AFTER_RESTART')

    // Clean up the shell.
    await client2.close(sessionId)
    rmSync(workRoot, { recursive: true, force: true })
  })

  /**
   * The `emacsclient -nw` half of the restore: a program's one-time terminal setup is
   * not in the replay (the ring buffer evicts it long before a days-old session is
   * re-attached), so the daemon tracks the sticky modes for the PTY's whole life and
   * re-asserts them AFTER the replay. Here the setup is still in the buffer — what is
   * being proven end-to-end (real socket, real PTY) is that the re-assertion happens,
   * in the right order, and only on a RE-attach.
   */
  it('re-asserts the sticky terminal modes on re-attach, after the replay', async () => {
    const { socketPath } = await startServer()
    const sessionId = 'sess-modes'
    const workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-wt-')))

    const client1 = makeClient(socketPath)
    await client1.ensureReady()
    const sink1 = recordingSink()
    client1.registerSink(sessionId, sink1)
    await client1.spawn({
      sessionId,
      taskId: 'task-1',
      shell: '/bin/bash',
      args: ['--norc', '--noprofile', '-i'],
      cwd: workRoot,
      cols: 80,
      rows: 24
    })

    // Stand in for a TUI's startup: bracketed paste on, then the alternate screen.
    client1.write(sessionId, "printf '\\033[?2004h\\033[?1049h'; echo OCTOPUS_MODES_SET\n")
    await waitFor(sink1.text, (s) => s.includes('\x1b[?1049h'))
    // The spawn-path attach must NOT have re-asserted anything: the only occurrence so
    // far is the one the program itself wrote.
    expect(sink1.text().split('\x1b[?1049h')).toHaveLength(2)

    client1.dispose()
    await new Promise((r) => setTimeout(r, 50))

    const client2 = makeClient(socketPath)
    await client2.ensureReady()
    const sink2 = recordingSink()
    client2.registerSink(sessionId, sink2)
    expect(await client2.attach(sessionId)).toBe(true)

    // The restore trails the replayed scrollback, so the history lands in the NORMAL
    // buffer and only then does the terminal switch to a clean alternate screen.
    const seen = await waitFor(sink2.text, (s) => s.endsWith('\x1b[?1049h'))
    expect(seen).toContain('OCTOPUS_MODES_SET')
    const restore = seen.slice(seen.lastIndexOf('\x1b[?2004h'))
    expect(restore).toBe('\x1b[?2004h\x1b[?1049h')

    await client2.close(sessionId)
    rmSync(workRoot, { recursive: true, force: true })
  })

  it('close() terminates the shell and removes it from the roster', async () => {
    const { socketPath } = await startServer()
    const sessionId = 'sess-close'
    const workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-wt-')))
    const client = makeClient(socketPath)
    await client.ensureReady()
    client.registerSink(sessionId, recordingSink())
    await client.spawn({
      sessionId,
      taskId: 'task-1',
      shell: '/bin/bash',
      args: ['--norc', '--noprofile', '-i'],
      cwd: workRoot,
      cols: 80,
      rows: 24
    })
    expect((await client.listSessions()).some((s) => s.sessionId === sessionId)).toBe(true)

    await client.close(sessionId)
    expect((await client.listSessions()).some((s) => s.sessionId === sessionId)).toBe(false)
    rmSync(workRoot, { recursive: true, force: true })
  })

  it('reports a spontaneous exit to the attached sink (shell exits on its own)', async () => {
    const { socketPath } = await startServer()
    const sessionId = 'sess-exit'
    const workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-wt-')))
    const client = makeClient(socketPath)
    await client.ensureReady()
    const sink = recordingSink()
    client.registerSink(sessionId, sink)
    await client.spawn({
      sessionId,
      taskId: 'task-1',
      shell: '/bin/bash',
      args: ['--norc', '--noprofile', '-i'],
      cwd: workRoot,
      cols: 80,
      rows: 24
    })

    client.write(sessionId, 'exit 7\n')
    await waitFor(
      () => String(sink.exits.length),
      (s) => s !== '0'
    )
    expect(sink.exits).toContain(7)
    rmSync(workRoot, { recursive: true, force: true })
  })
})
