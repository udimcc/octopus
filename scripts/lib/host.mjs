// The build scripts' only reader of `process.platform` (the plain-Node mirror of
// `src/shared/node/os/host.ts`, which scripts cannot import as TypeScript). Same
// mapping as `toOsId` in `src/shared/os`: anything unknown is treated as linux.

/** @returns {'linux' | 'darwin' | 'win32'} */
export function hostOs() {
  const p = process.platform
  return p === 'darwin' || p === 'win32' ? p : 'linux'
}

/** True when the build runs on macOS. */
export function isMacHost() {
  return hostOs() === 'darwin'
}
