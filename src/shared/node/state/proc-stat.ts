/**
 * Layer-2 structural signal (DESIGN §9.1): is the shell at its prompt, or is a
 * child running in the foreground? DESIGN §9.1 phrases this as
 * `tcgetpgrp(master_fd) vs shell PGID`, but node-pty does NOT expose the PTY master
 * fd, so we read the same two numbers from `/proc/<shellPid>/stat` instead — no
 * native binding required, and it works identically whoever owns the fd (the
 * in-process runtime OR the daemon, §9.6):
 *
 *   - field  5 `pgrp`  — the shell's own process-group id.
 *   - field  8 `tpgid` — the foreground process group of the controlling terminal.
 *
 * `tpgid === pgrp` → the SHELL is the terminal's foreground group → it is sitting at
 * the prompt (Waiting/Idle). Otherwise a child pipeline is in the foreground
 * (Working), and `tpgid` is that pipeline's pgid — reading `/proc/<tpgid>/comm`
 * names the running program, which is how the composite picks the per-program
 * Layer-3 detector (§9.3, e.g. `claude`).
 *
 * ## The comm-parsing hazard
 * `/proc/<pid>/stat` field 2 (`comm`) is wrapped in parentheses and MAY itself
 * contain spaces and parens (e.g. a process named `(my proc)` renders as
 * `((my proc))`). A naive whitespace split corrupts every field after it. The
 * robust parse — used by the kernel's own consumers — is to split on the LAST `)`
 * in the line: everything before its matching `(` is `comm`, the tail after it is
 * the space-separated numeric fields starting at field 3 (`state`).
 *
 * Linux-only by design (the target is a Linux VDI); on any platform without `/proc`
 * the reads throw and the resolver returns `undefined` (→ the composite reports
 * `Unknown`). Ids/strings are plain here (the `shared` convention: no `domain`).
 */

import { readFileSync } from 'node:fs'

/** The subset of `/proc/<pid>/stat` fields Layer 2 needs. */
export interface ProcStat {
  readonly pid: number
  /** The `comm` field with its wrapping parens stripped (may contain spaces). */
  readonly comm: string
  /** Field 5: the process's own process-group id. */
  readonly pgrp: number
  /** Field 8: the controlling terminal's foreground process group (-1 if none). */
  readonly tpgid: number
}

/**
 * Parse the raw contents of a `/proc/<pid>/stat` line. Returns `undefined` if the
 * line is malformed (no paren, too few fields) rather than throwing — a transient
 * read of a dying process must degrade, not crash the poll loop.
 *
 * Field layout after the closing `)` (1-indexed per proc(5), so the token AT index
 * 0 of the post-paren split is field 3):
 *   3 state · 4 ppid · 5 pgrp · 6 session · 7 tty_nr · 8 tpgid · …
 */
export function parseProcStat(content: string): ProcStat | undefined {
  const lastParen = content.lastIndexOf(')')
  const firstParen = content.indexOf('(')
  if (firstParen === -1 || lastParen === -1 || lastParen < firstParen) {
    return undefined
  }

  const pid = Number.parseInt(content.slice(0, firstParen).trim(), 10)
  const comm = content.slice(firstParen + 1, lastParen)

  // Tokens after the closing paren: index 0 = field 3 (state), so field N is at
  // index N-3. We need field 5 (pgrp → idx 2) and field 8 (tpgid → idx 5).
  const rest = content
    .slice(lastParen + 1)
    .trim()
    .split(/\s+/)
  if (rest.length < 6) {
    return undefined
  }

  const pgrp = Number.parseInt(rest[2], 10)
  const tpgid = Number.parseInt(rest[5], 10)
  if (!Number.isInteger(pid) || !Number.isInteger(pgrp) || !Number.isInteger(tpgid)) {
    return undefined
  }
  return { pid, comm, pgrp, tpgid }
}

/** Read + parse `/proc/<pid>/stat`. `undefined` if the pid is gone or non-Linux. */
export function readProcStat(pid: number): ProcStat | undefined {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The `comm` (executable name) of a process, from `/proc/<pid>/comm`. This is the
 * clean single-line name (kernel-truncated to 15 chars) — preferred over the
 * stat-embedded comm for detector matching. `undefined` if unreadable.
 */
export function readComm(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return undefined
  }
}

/** The foreground picture for a shell PTY (§9.1). */
export interface ForegroundInfo {
  /** True when the shell itself owns the terminal foreground (at the prompt). */
  readonly atPrompt: boolean
  /** The foreground pipeline's pgid when a child is running (else the shell's). */
  readonly foregroundPgid: number
  /** The foreground program's `comm` when a child is running (§9.3 detector key). */
  readonly comm?: string
}

/**
 * Resolve whether `shellPid`'s terminal is at the prompt or running a child, and —
 * when running — the foreground program's `comm` (§9.1/§9.3). `undefined` if the
 * shell's stat can't be read (dead pid / non-Linux) so the composite skips Layer 2.
 */
export function resolveForeground(shellPid: number): ForegroundInfo | undefined {
  const stat = readProcStat(shellPid)
  if (!stat) {
    return undefined
  }
  // No controlling terminal (tpgid -1) — treat as at-prompt (nothing running).
  if (stat.tpgid < 0 || stat.tpgid === stat.pgrp) {
    return { atPrompt: true, foregroundPgid: stat.pgrp }
  }
  // A child pipeline is in the foreground; name it via /proc/<tpgid>/comm. The
  // stat-embedded comm of the pgid leader is the fallback if /comm is unreadable.
  const comm = readComm(stat.tpgid) ?? readProcStat(stat.tpgid)?.comm
  return { atPrompt: false, foregroundPgid: stat.tpgid, comm }
}
