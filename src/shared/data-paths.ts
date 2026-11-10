/**
 * Pure data-dir + control-socket path resolution. Lives in `shared` so BOTH
 * `adapters/env/paths.ts` and the out-of-process `src/cli` (which may import only
 * `shared`) resolve the same locations. No I/O, no node imports (compiles under both
 * TS projects).
 *
 * Data dir (DESIGN §6.3): `$XDG_DATA_HOME/octopus` (Linux, XDG_DATA_HOME must be
 * absolute, else `~/.local/share/octopus`), `%APPDATA%\octopus` (Windows).
 */

/** Folder name under the platform base data dir. */
export const APP_DIR_NAME = 'octopus'

/** Env var carrying the control socket path into session PTYs (and read by the CLI). */
export const OCTOPUS_CONTROL_SOCKET_ENV = 'OCTOPUS_CONTROL_SOCKET'

/** File name of the control socket inside the data dir. */
export const CONTROL_SOCKET_FILE = 'control.sock'

/**
 * Unix domain socket paths are limited to ~107 bytes (`sun_path` is 108 incl. NUL).
 * A deep `XDG_DATA_HOME` can exceed it, in which case `listen`/`connect` fail with
 * ENAMETOOLONG; callers should surface that clearly.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 107

export interface DataDirContext {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: string
  readonly home: string
}

function joinPath(platform: string, ...parts: string[]): string {
  const sep = platform === 'win32' ? '\\' : '/'
  let out = parts[0] ?? ''
  for (const part of parts.slice(1)) {
    out = (out.endsWith(sep) ? out : out + sep) + part
  }
  return out
}

/** Platform base data dir per the XDG Base Directory spec / Windows convention. */
function baseDataDir({ env, platform, home }: DataDirContext): string {
  if (platform === 'win32') {
    return env.APPDATA && env.APPDATA.length > 0
      ? env.APPDATA
      : joinPath(platform, home, 'AppData', 'Roaming')
  }
  const xdg = env.XDG_DATA_HOME
  if (xdg && xdg.startsWith('/')) {
    return xdg
  }
  return joinPath(platform, home, '.local', 'share')
}

/** Root data directory for this app. Pure. */
export function resolveDataDir(ctx: DataDirContext): string {
  return joinPath(ctx.platform, baseDataDir(ctx), APP_DIR_NAME)
}

/** Control socket path: `<dataDir>/control.sock`. Pure; see {@link MAX_UNIX_SOCKET_PATH_BYTES}. */
export function controlSocketPath(dataDir: string, platform: string = 'linux'): string {
  return joinPath(platform, dataDir, CONTROL_SOCKET_FILE)
}

/** Convenience: control socket path straight from an environment. */
export function resolveControlSocketPath(ctx: DataDirContext): string {
  return controlSocketPath(resolveDataDir(ctx), ctx.platform)
}
