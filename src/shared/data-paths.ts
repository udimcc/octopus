/**
 * Pure data-dir + control-socket path resolution. Lives in `shared` so BOTH
 * `adapters/env/paths.ts` and the out-of-process `src/cli` (which may import only
 * `shared`) resolve the same locations. No I/O, no node imports (compiles under both
 * TS projects).
 *
 * Every OS difference comes from the passed {@link OsProfile} (`src/shared/os`).
 *
 * Data dir (DESIGN §6.3): `$XDG_DATA_HOME/octopus` (Linux, XDG_DATA_HOME must be
 * absolute, else `~/.local/share/octopus`), `%APPDATA%\octopus` (Windows).
 *
 * macOS DELIBERATELY falls through to the XDG branch (`~/.local/share/octopus`),
 * not `~/Library/Application Support/...`:
 *  - Electron's default `userData` there is `~/Library/Application Support/Octopus`,
 *    which on the default case-insensitive APFS volume IS the same directory as
 *    `.../octopus` — our DB, sockets and credentials would mix with Chromium's
 *    profile (and the dev-build `electron-dev` userData would nest inside it).
 *  - Unix socket paths are short on darwin (103 usable bytes, see
 *    `OsProfile.paths.maxUnixSocketPathBytes`); the space in "Application Support" plus a long
 *    home dir eats into that budget for `control.sock` and the daemon socket.
 *  - The CLI (`src/cli`) and the app must agree on the path from env alone, and one
 *    rule for every POSIX platform keeps that trivially true.
 */

import type { OsProfile, PathSeparator } from './os'

/** Folder name under the platform base data dir. */
export const APP_DIR_NAME = 'octopus'

/** Env var carrying the control socket path into session PTYs (and read by the CLI). */
export const OCTOPUS_CONTROL_SOCKET_ENV = 'OCTOPUS_CONTROL_SOCKET'

/** File name of the control socket inside the data dir. */
export const CONTROL_SOCKET_FILE = 'control.sock'

export interface DataDirContext {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly os: OsProfile
  readonly home: string
}

function joinPath(sep: PathSeparator, ...parts: string[]): string {
  let out = parts[0] ?? ''
  for (const part of parts.slice(1)) {
    out = (out.endsWith(sep) ? out : out + sep) + part
  }
  return out
}

/** Platform base data dir per the XDG Base Directory spec / Windows convention. */
function baseDataDir({ env, os, home }: DataDirContext): string {
  const sep = os.paths.separator
  if (os.paths.dataDirBase === 'appdata') {
    return env.APPDATA && env.APPDATA.length > 0
      ? env.APPDATA
      : joinPath(sep, home, 'AppData', 'Roaming')
  }
  // darwin shares this XDG branch on purpose — see the module comment.
  const xdg = env.XDG_DATA_HOME
  if (xdg && xdg.startsWith('/')) {
    return xdg
  }
  return joinPath(sep, home, '.local', 'share')
}

/** Root data directory for this app. Pure. */
export function resolveDataDir(ctx: DataDirContext): string {
  return joinPath(ctx.os.paths.separator, baseDataDir(ctx), APP_DIR_NAME)
}

/**
 * Control socket path: `<dataDir>/control.sock`. Pure. Unix socket paths are limited
 * to `sun_path` minus the NUL (`os.paths.maxUnixSocketPathBytes`: 107 on Linux, 103 on
 * macOS); a deep `XDG_DATA_HOME` can exceed it, in which case `listen`/`connect` fail
 * with ENAMETOOLONG and callers should surface that clearly.
 */
export function controlSocketPath(dataDir: string, os: OsProfile): string {
  return joinPath(os.paths.separator, dataDir, CONTROL_SOCKET_FILE)
}

/** Convenience: control socket path straight from an environment. */
export function resolveControlSocketPath(ctx: DataDirContext): string {
  return controlSocketPath(resolveDataDir(ctx), ctx.os)
}
