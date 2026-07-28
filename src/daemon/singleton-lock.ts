/**
 * Single-daemon-per-uid guard (DESIGN §6.2). The control socket path itself is
 * the lock: binding a Unix socket is atomic, so a successful `listen` means we own
 * it. The wrinkle is a STALE socket file left by a crashed daemon — the file
 * exists, so bind fails with EADDRINUSE, but nothing is listening. We disambiguate
 * by probing: connect to the path; if something answers, a live daemon owns it and
 * we back off; if the connection is refused, the socket is stale — unlink it and
 * let the caller retry the bind.
 *
 * Pure of the server: it takes a `tryListen` thunk so the probe/retry logic is
 * testable without a real net server.
 */

import { connect } from 'node:net'
import { unlinkSync, existsSync } from 'node:fs'

/** Is a daemon currently listening on `socketPath`? Resolves fast, never rejects. */
export function probeExisting(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(socketPath)) {
      resolve(false)
      return
    }
    const sock = connect(socketPath)
    const done = (answer: boolean): void => {
      sock.destroy()
      resolve(answer)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false)) // ECONNREFUSED / ENOENT → stale
    sock.setTimeout(timeoutMs, () => done(false))
  })
}

/** Remove a stale socket file if present. Best-effort. */
export function removeStaleSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath)
    }
  } catch {
    // ignore — the subsequent bind will surface a real conflict
  }
}

/**
 * Acquire the singleton socket: bind, or if the path is taken, probe. Returns
 * `true` if we now own it, `false` if a live daemon already holds it (caller
 * should exit). Retries the bind ONCE after clearing a stale file.
 */
export async function acquireSingleton(
  socketPath: string,
  tryListen: () => Promise<void>
): Promise<boolean> {
  try {
    await tryListen()
    return true
  } catch (err) {
    if (!isAddrInUse(err)) {
      throw err
    }
  }
  // Path taken — is a real daemon there?
  if (await probeExisting(socketPath)) {
    return false
  }
  // Stale socket from a crashed daemon: clear and retry once.
  removeStaleSocket(socketPath)
  await tryListen()
  return true
}

function isAddrInUse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EADDRINUSE'
}
