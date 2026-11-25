/**
 * Best-effort current-working-directory of live processes (DESIGN §6.2). The PTY
 * carries no cwd of its own, so this is the only way to observe where a shell has
 * `cd`'d to after spawn.
 *
 * Lives under `src/shared/node/` (not `src/daemon/`) because BOTH ends need it: the
 * daemon resolves it for its `listSessions` roster, and the in-process
 * `PtyTerminalRuntime` (an adapter) resolves it for the same query. Placing it in
 * `shared` lets `adapters` import it without violating the boundary rule (adapters
 * may not import `src/daemon/**`). Uses node `fs`/`child_process`, so it belongs
 * under `shared/node`, not the browser-safe `shared` root.
 *
 * - **Linux** (the VDI target): `readlink /proc/<pid>/cwd`, synchronous and cheap.
 * - **macOS** (no `/proc`): ONE async `lsof -a -d cwd -Fn -p <pid,pid,…>` for the
 *   whole batch, with a short timeout. Never `execFileSync` it: the daemon calls this
 *   on the event loop that pumps every PTY's output, and a fork costs 20–100 ms.
 *   `lsof` is invoked by absolute path because a GUI launch's PATH may lack /usr/sbin.
 *
 * A pid that has exited (or any failure) resolves to `undefined`, which callers treat
 * as "cwd unavailable".
 */

import { execFile } from 'node:child_process'
import { readlinkSync } from 'node:fs'

const LSOF = '/usr/sbin/lsof'
const LSOF_TIMEOUT_MS = 1000

/** Best-effort cwd of a pid via /proc (Linux). Undefined if unresolvable. */
export function procCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return undefined
  }
}

/**
 * Parse `lsof -Fn` field output (`p<pid>` starts a process set, `f<fd>` a file,
 * `n<name>` its path) into pid → cwd. Only an `n` line under an `fcwd` file counts.
 * Pure, for unit tests.
 */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid: number | undefined
  let fd: string | undefined
  for (const line of stdout.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const n = Number(value)
      pid = Number.isInteger(n) && n > 0 ? n : undefined
      fd = undefined
    } else if (tag === 'f') {
      fd = value
    } else if (tag === 'n' && pid !== undefined && fd === 'cwd' && value !== '') {
      out.set(pid, value)
    }
  }
  return out
}

/** One lsof call for the whole batch. Partial results survive a non-zero exit. */
function lsofCwds(pids: readonly number[]): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    try {
      execFile(
        LSOF,
        ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')],
        { timeout: LSOF_TIMEOUT_MS, encoding: 'utf8' },
        // lsof exits 1 when ANY listed pid is gone, yet still prints the others.
        (_err, stdout) => resolve(parseLsofCwd(typeof stdout === 'string' ? stdout : ''))
      )
    } catch {
      resolve(new Map())
    }
  })
}

/**
 * Resolve the cwd of many pids at once (pid → cwd; unresolvable pids are absent).
 * macOS uses one batched `lsof`; everywhere else (Linux) reads `/proc` per pid.
 */
export async function procCwds(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform
): Promise<Map<number, string>> {
  const valid = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0)
  if (valid.length === 0) {
    return new Map()
  }
  if (platform === 'darwin') {
    return lsofCwds(valid)
  }
  const out = new Map<number, string>()
  for (const pid of valid) {
    const cwd = procCwd(pid)
    if (cwd !== undefined) {
      out.set(pid, cwd)
    }
  }
  return out
}

/** Async single-pid convenience over {@link procCwds}. */
export async function procCwdAsync(pid: number): Promise<string | undefined> {
  return (await procCwds([pid])).get(pid)
}
