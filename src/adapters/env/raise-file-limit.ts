import { execFileSync } from 'node:child_process'

/**
 * Raise the process's RLIMIT_NOFILE (open-file descriptor) soft limit toward
 * {@link TARGET_SOFT_NOFILE} (DESIGN §6.1). Dozens of PTYs, sockets and DB
 * handles exhaust the default soft limit of 1024, so V1's session backend needs
 * plenty of headroom — and child processes inherit whatever limit is in effect
 * when they are spawned, so this must run FIRST during bootstrap.
 *
 * Node has no built-in setrlimit, so we shell out to `prlimit(1)` (util-linux)
 * targeting our own PID. Raising the *soft* limit up to the existing *hard* limit
 * needs no privilege; raising the hard limit would (CAP_SYS_RESOURCE), which we
 * never attempt. This is best-effort: any failure is logged and swallowed so a
 * missing `prlimit` or a locked-down host never blocks startup.
 */
export const TARGET_SOFT_NOFILE = 65536

export interface RaiseFileLimitResult {
  /** True if a `prlimit` call was issued (Linux with a soft limit below target). */
  attempted: boolean
  /** The soft limit we asked the kernel to set, if we attempted. */
  requestedSoft?: number
  /** Human-readable outcome for logging. */
  message: string
}

/**
 * @param enabled the host profile's `proc.raiseFileLimit` (true only where `prlimit`
 *   exists, i.e. Linux); when false this is a logged no-op.
 */
export function raiseFileLimit(enabled: boolean): RaiseFileLimitResult {
  if (!enabled) {
    return { attempted: false, message: 'skipped: not supported on this OS' }
  }

  try {
    // Read current soft/hard. `-o SOFT,HARD` restricts output to just those two
    // columns (the default DESCRIPTION column contains spaces and would break a
    // whitespace split); `--noheadings --raw` drops the header and alignment.
    const current = execFileSync(
      'prlimit',
      ['--pid', String(process.pid), '--nofile', '--noheadings', '--raw', '-o', 'SOFT,HARD'],
      { encoding: 'utf8' }
    ).trim()

    // Output columns: SOFT HARD  (e.g. "1024 1048576", hard may be "unlimited")
    const parts = current.split(/\s+/)
    const soft = Number(parts[0])
    const hard = parseHard(parts[1])

    if (!Number.isFinite(soft)) {
      return { attempted: false, message: `skipped: could not parse prlimit output "${current}"` }
    }

    if (soft >= TARGET_SOFT_NOFILE) {
      return { attempted: false, message: `already sufficient: soft=${soft}` }
    }

    // Never exceed the hard cap (unprivileged processes cannot raise it).
    const requestedSoft = Number.isFinite(hard)
      ? Math.min(TARGET_SOFT_NOFILE, hard)
      : TARGET_SOFT_NOFILE
    const hardArg = Number.isFinite(hard) ? String(hard) : 'unlimited'

    execFileSync('prlimit', ['--pid', String(process.pid), `--nofile=${requestedSoft}:${hardArg}`])

    return {
      attempted: true,
      requestedSoft,
      message:
        requestedSoft < TARGET_SOFT_NOFILE
          ? `raised soft ${soft} → ${requestedSoft} (capped by hard limit ${hard})`
          : `raised soft ${soft} → ${requestedSoft}`
    }
  } catch (err) {
    return { attempted: false, message: `skipped: ${(err as Error).message}` }
  }
}

/** The hard column may be the literal "unlimited"; treat that as +Infinity. */
function parseHard(raw: string | undefined): number {
  if (raw === undefined) return NaN
  if (raw === 'unlimited') return Infinity
  return Number(raw)
}
