/**
 * The host platform as seen by the renderer (`window.octopusAPI.getPlatform()`, a
 * synchronous preload read of `process.platform`). Falls back to `'linux'` when the
 * bridge or the method is absent — many tests install partial `window.octopusAPI`
 * mocks, and the Linux behavior is the historical default.
 */
export function getPlatform(): string {
  const api = window.octopusAPI as Partial<typeof window.octopusAPI> | undefined
  return typeof api?.getPlatform === 'function' ? api.getPlatform() : 'linux'
}

/** True on macOS. */
export function isMac(): boolean {
  return getPlatform() === 'darwin'
}
