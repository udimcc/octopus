/**
 * `UpdateSource` over the local/network filesystem (DESIGN: update check). A
 * candidate is a subdirectory holding every file in `markers` (the host profile's
 * `update.releaseMarkers`, `src/shared/os`), so a Linux build never offers a Mac release and vice versa. Names are returned unparsed. The directory read is
 * raced against a timeout so a hung network mount reports `unreachable` instead
 * of blocking startup. An abandoned read is kept per dir and reused by the next
 * check instead of starting another readdir, so a hung mount pins at most one libuv
 * pool thread per dir. Staging copies into a configured local dir and is also raced
 * against a timeout.
 *
 * The release tree is copied and removed with `cp -a` / `rm -rf` child processes, never
 * with `fs.cp`/`fs.rm`: in Electron's main process `fs` (including the internals of
 * `fs.cp`/`fs.rm`) treats every `*.asar` file as a virtual directory, so copying
 * `linux-unpacked/resources/app.asar` with it produces an "Invalid package" archive. A
 * child process sees plain files, and the copy can be killed when it times out.
 */

import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { ListCandidatesResult, UpdateCandidate, UpdateSource } from '../../ports/update-source'
import type { ScriptRunner } from '../../ports/script-runner'

const TIMEOUT = Symbol('timeout')
/** Prefix of every staged copy under the staging root (the only dirs `cleanup` removes). */
const STAGE_PREFIX = 'octopus-update-'
const STDERR_TAIL_CHARS = 2000

/** Files (relative to the release dir) that mark a macOS release (`scripts/release.mjs`). */
export const MAC_RELEASE_MARKERS: readonly string[] = [
  'install-mac.sh',
  'Octopus.app/Contents/MacOS/Octopus'
]

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface FsUpdateSourceOptions {
  /** Local dir the release copy is staged under (created on demand). */
  readonly stagingRoot: string
  /** Gives up copying the release after this long. */
  readonly stageTimeoutMs: number
  /** Runs the `cp -a` / `rm -rf` child processes. */
  readonly runner: ScriptRunner
  /** Files a release dir must contain to be a candidate (host profile `update.releaseMarkers`). */
  readonly markers: readonly string[]
}

export class FsUpdateSource implements UpdateSource {
  private readonly pendingScans = new Map<string, Promise<UpdateCandidate[]>>()
  private copyInFlight = false

  constructor(private readonly options: FsUpdateSourceOptions) {}

  async listCandidates(dir: string, timeoutMs: number): Promise<ListCandidatesResult> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
    })
    try {
      let scan = this.pendingScans.get(dir)
      if (scan === undefined) {
        const started = this.scan(dir)
        scan = started
        this.pendingScans.set(dir, started)
        const forget = (): void => {
          if (this.pendingScans.get(dir) === started) {
            this.pendingScans.delete(dir)
          }
        }
        // Also marks a scan abandoned by the timeout as handled (no unhandled rejection).
        started.then(forget, forget)
      }
      const result = await Promise.race([scan, timeout])
      if (result === TIMEOUT) {
        return { kind: 'unreachable', reason: `timed out after ${timeoutMs} ms reading ${dir}` }
      }
      return { kind: 'ok', candidates: result }
    } catch (err) {
      return { kind: 'unreachable', reason: errorMessage(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  private async scan(dir: string): Promise<UpdateCandidate[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const found: UpdateCandidate[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const path = join(dir, entry.name)
      if (await this.hasMarkers(path)) {
        found.push({ name: entry.name, path })
      }
    }
    return found
  }

  private async hasMarkers(path: string): Promise<boolean> {
    for (const marker of this.options.markers) {
      if (!(await isFile(join(path, ...marker.split('/'))))) {
        return false
      }
    }
    return true
  }

  async stageToTemp(releasePath: string): Promise<string> {
    if (this.copyInFlight) {
      throw new Error('A previous update copy is still in progress — try again later')
    }
    await mkdir(this.options.stagingRoot, { recursive: true })
    await this.removeStale()
    const tmp = await mkdtemp(join(this.options.stagingRoot, STAGE_PREFIX))
    const copy = this.copyTree(releasePath, tmp)
    // A copy stuck on a hung mount may outlive even SIGKILL: keep it tracked until it
    // settles so a retry cannot stack another.
    this.copyInFlight = true
    const settled = (): void => {
      this.copyInFlight = false
    }
    copy.then(settled, settled)
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), this.options.stageTimeoutMs)
    })
    try {
      if ((await Promise.race([copy, timeout])) === TIMEOUT) {
        // Remove what exists now and again once the copy settles.
        const again = (): void => void this.cleanup(tmp)
        copy.then(again, again)
        throw new Error('Copying the update timed out')
      }
    } catch (err) {
      await this.cleanup(tmp)
      throw err
    } finally {
      clearTimeout(timer)
    }
    return tmp
  }

  /** Best-effort removal of `octopus-update-*` dirs left by a previous quit/crash. */
  private async removeStale(): Promise<void> {
    try {
      const entries = await readdir(this.options.stagingRoot, { withFileTypes: true })
      await Promise.all(
        entries
          .filter((e) => e.isDirectory() && e.name.startsWith(STAGE_PREFIX))
          .map((e) => this.cleanup(join(this.options.stagingRoot, e.name)))
      )
    } catch {
      // best-effort
    }
  }

  /** `cp -a <release>/. <tmp>/` (symlinks and modes preserved); rejects on failure. */
  private async copyTree(releasePath: string, tmp: string): Promise<void> {
    const res = await this.options.runner.run('cp', ['-a', '--', `${releasePath}/.`, tmp], {
      cwd: this.options.stagingRoot,
      timeoutMs: this.options.stageTimeoutMs,
      killProcessGroup: true
    })
    if (res.timedOut) {
      throw new Error('Copying the update timed out')
    }
    if (res.exitCode !== 0) {
      const tail = res.stderr.trim().slice(-STDERR_TAIL_CHARS)
      throw new Error(`Copying the update failed${tail ? `: ${tail}` : ''}`)
    }
  }

  /** Best-effort `rm -rf` of a staged copy; refuses anything outside the staging root. */
  async cleanup(tmpPath: string): Promise<void> {
    if (!tmpPath.startsWith(join(this.options.stagingRoot, STAGE_PREFIX))) return
    if (tmpPath.slice(this.options.stagingRoot.length + 1).includes(sep)) return
    try {
      await this.options.runner.run('rm', ['-rf', '--', tmpPath], {
        cwd: this.options.stagingRoot,
        timeoutMs: this.options.stageTimeoutMs,
        killProcessGroup: true
      })
    } catch {
      // best-effort
    }
  }
}
