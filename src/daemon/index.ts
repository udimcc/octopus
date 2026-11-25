/**
 * `octopusd` entry point (DESIGN §6.2): a long-lived, detached helper process that
 * OWNS all terminal PTYs so they survive an Octopus app restart. The app
 * (re)connects over the per-uid control socket and re-attaches to still-running
 * shells — carrying cwd, live programs (vim/Claude), and scrollback across the
 * restart. This is the durable `SessionManager` backend §6.2/§10 reserved.
 *
 * Runs on the bundled Electron binary via `ELECTRON_RUN_AS_NODE=1` (no host-node
 * dependency in the air-gapped release) — node-pty is N-API/ABI-stable so it loads
 * under Electron's Node exactly as under host Node (validated in Phase 1).
 *
 * ## Lifecycle / idle policy
 * The daemon outlives the app while it has work: it exits ONLY when it holds 0
 * live sessions AND has had 0 connected clients for the idle window. It NEVER
 * exits while a PTY is alive (that would defeat durability). An app quit merely
 * drops the client connection — the daemon keeps every PTY running.
 *
 * A daemon crash kills its child PTYs (they are its children); the app then falls
 * back to fresh spawns (§6.2 — the durability guarantee is against APP restarts,
 * not daemon crashes).
 */

import { PtyRegistry } from './pty-registry'
import { hostProfile } from '../shared/node/os/host'
import { DaemonServer } from './server'
import { acquireSingleton } from './singleton-lock'
import { controlSocketPath, ensureDaemonDir, currentUid } from '../shared/node/daemon-paths'

/** Grace before a client-less, session-less daemon exits (ms). */
const IDLE_EXIT_MS = 30_000

const DAEMON_VERSION = process.env.OCTOPUS_DAEMON_VERSION ?? '0.0.0'

async function main(): Promise<void> {
  const uid = currentUid()
  ensureDaemonDir(uid)
  const socketPath = controlSocketPath(uid)

  // State detection is no longer a daemon concern (§9.6): the Claude hook recorder
  // appends to each session's events log (keyed by OCTOPUS_SESSION_ID) and a single
  // app-side watcher feeds the Application. The daemon only owns PTY lifecycle.
  const registry = new PtyRegistry({ os: hostProfile() })

  let idleTimer: ReturnType<typeof setTimeout> | null = null

  // `evaluateIdle`/`shutdown` reference `server` and are passed INTO its
  // constructor, so they are hoisted `function` declarations (server is a `const`
  // assigned just below; the bodies only run after it exists).
  function evaluateIdle(): void {
    const idle = registry.size === 0 && server.clientCount === 0
    if (idle && idleTimer === null) {
      idleTimer = setTimeout(() => {
        // Re-check at fire time: a client may have (re)connected during the window.
        if (registry.size === 0 && server.clientCount === 0) {
          void shutdown(0)
        }
      }, IDLE_EXIT_MS)
      idleTimer.unref?.()
    } else if (!idle && idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  async function shutdown(code: number): Promise<void> {
    try {
      await server.close()
    } finally {
      process.exit(code)
    }
  }

  const server = new DaemonServer({
    registry,
    socketPath,
    daemonVersion: DAEMON_VERSION,
    onActivity: evaluateIdle,
    onSessionGone: evaluateIdle
  })

  const acquired = await acquireSingleton(socketPath, () => server.listen())
  if (!acquired) {
    // Another live daemon already owns the socket — nothing to do.
    process.exit(0)
    return
  }

  // A parent-less daemon must not die from SIGHUP when the launching terminal
  // closes; it is deliberately detached (§6.2). SIGTERM/SIGINT still shut it down.
  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))

  // Arm the initial idle timer (started with 0 sessions, 0 clients).
  evaluateIdle()
  console.log(`[octopusd] listening on ${socketPath} (v${DAEMON_VERSION}, pid ${process.pid})`)
}

void main().catch((err) => {
  console.error('[octopusd] fatal:', err)
  process.exit(1)
})
