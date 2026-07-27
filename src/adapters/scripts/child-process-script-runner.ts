/**
 * `ScriptRunner` over `child_process.spawn` (DESIGN §6.4, I17).
 *
 * **Trust boundary (I17, R3).** The command and its arguments are passed as an
 * argv array with `shell: false` (the spawn default, asserted explicitly). A task
 * or branch name containing `; rm -rf ~` is therefore just an argv string the
 * script receives verbatim — it is NEVER interpolated into a shell. This is the
 * single most important property of this adapter.
 *
 * Responsibilities: enforce cwd + a sanitized env, stream stdout/stderr
 * line-by-line, cap captured stderr, and enforce a timeout via SIGTERM → grace →
 * SIGKILL. Resolves with the captured result on exit/kill; rejects only on spawn
 * failure (ENOENT etc.), never on a non-zero exit — a failed script is a normal,
 * inspectable result (§6.4).
 */

import { spawn } from 'node:child_process'
import type { ScriptRunner, ScriptRunOptions, ScriptResult } from '../../ports/script-runner'
import { LineSplitter } from './line-splitter'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_GRACE_MS = 2_000
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

export class ChildProcessScriptRunner implements ScriptRunner {
  run(command: string, args: readonly string[], opts: ScriptRunOptions): Promise<ScriptResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
    const maxStderrBytes = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES

    return new Promise<ScriptResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: buildEnv(process.env, opts.env),
        // I17: NEVER a shell. argv is passed straight to execve.
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      const stderrParts: string[] = []
      let stderrBytes = 0
      let timedOut = false
      let settled = false

      const outSplitter = new LineSplitter((line) => opts.onStdoutLine?.(line))
      const errSplitter = new LineSplitter((line) => opts.onStderrLine?.(line))

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
        outSplitter.push(chunk)
      })

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        // Cap the retained stderr (§6.4) but keep streaming lines regardless.
        if (stderrBytes < maxStderrBytes) {
          const room = maxStderrBytes - stderrBytes
          const slice = chunk.length <= room ? chunk : chunk.slice(0, room)
          stderrParts.push(slice)
          stderrBytes += slice.length
        }
        errSplitter.push(chunk)
      })

      // SIGTERM at the timeout, then SIGKILL if it doesn't exit within the grace.
      const killTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        graceTimer = setTimeout(() => child.kill('SIGKILL'), graceMs)
      }, timeoutMs)
      let graceTimer: ReturnType<typeof setTimeout> | undefined

      const cleanup = (): void => {
        clearTimeout(killTimer)
        if (graceTimer) clearTimeout(graceTimer)
      }

      child.on('error', (err) => {
        if (settled) return
        settled = true
        cleanup()
        // Spawn failure (e.g. ENOENT: script path wrong / not executable).
        reject(err)
      })

      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        cleanup()
        outSplitter.end()
        errSplitter.end()
        resolve({
          exitCode: code,
          signal: signal,
          stdout,
          stderr: stderrParts.join(''),
          timedOut
        })
      })
    })
  }
}

/**
 * Build the child's environment: inherited env with the OCTOPUS_* overlay
 * applied. Pure and exported for testing. `undefined` inherited values are
 * dropped so they don't become the string "undefined"; overrides always win.
 */
export function buildEnv(
  inherited: NodeJS.ProcessEnv,
  overrides?: Readonly<Record<string, string>>
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value
    }
  }
  return env
}
