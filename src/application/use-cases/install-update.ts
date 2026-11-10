/**
 * Update installer. Stages the release dir to local temp, runs its `install.sh`
 * via `sh` (argv, no shell string), and on success relaunches into the freshly
 * installed binary. Never throws: every failure maps to `{ ok: false, error }`.
 * The temp dir is always cleaned up. One install at a time.
 */

import type { ScriptRunner } from '../../ports/script-runner'
import type { AppRelauncher, UpdateSource } from '../../ports/update-source'

export interface InstallUpdateDeps {
  readonly source: UpdateSource
  readonly scriptRunner: ScriptRunner
  readonly relauncher: AppRelauncher
  /** Directory install.sh installs into; the app binary is `<programDir>/octopus`. */
  readonly programDir: string
  readonly timeoutMs: number
}

export type InstallResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

export interface UpdateInstaller {
  install(releasePath: string): Promise<InstallResult>
}

const STDERR_TAIL_CHARS = 500

function tail(text: string): string {
  const t = text.trim()
  return t.length > STDERR_TAIL_CHARS ? `...${t.slice(-STDERR_TAIL_CHARS)}` : t
}

export function createUpdateInstaller(deps: InstallUpdateDeps): UpdateInstaller {
  let running = false

  async function run(releasePath: string): Promise<InstallResult> {
    let tmp: string | undefined
    try {
      tmp = await deps.source.stageToTemp(releasePath)
      const res = await deps.scriptRunner.run('sh', [`${tmp}/install.sh`], {
        cwd: tmp,
        timeoutMs: deps.timeoutMs,
        killProcessGroup: true
      })
      if (res.exitCode === 0 && !res.timedOut) {
        // Clean up BEFORE relaunching: relaunch quits the app, so a `finally` would not run.
        const staged = tmp
        tmp = undefined
        await deps.source.cleanup(staged).catch(() => undefined)
        deps.relauncher.relaunch(`${deps.programDir}/octopus`)
        return { ok: true }
      }
      const reason = res.timedOut
        ? 'Install timed out'
        : `Install failed (exit ${res.exitCode ?? res.signal ?? 'unknown'})`
      const err = tail(res.stderr)
      return { ok: false, error: err === '' ? reason : `${reason}: ${err}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      if (tmp !== undefined) {
        await deps.source.cleanup(tmp).catch(() => undefined)
      }
    }
  }

  return {
    async install(releasePath) {
      if (running) {
        return { ok: false, error: 'An install is already in progress' }
      }
      running = true
      try {
        return await run(releasePath)
      } finally {
        running = false
      }
    }
  }
}
