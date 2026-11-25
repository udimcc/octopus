import { osProfile, toOsId, type OsProfile } from '../../shared/os'

/**
 * The host OS profile as seen by the renderer (`window.octopusAPI.getPlatform()`, a
 * synchronous preload read of the host OS). Falls back to Linux when the bridge or the
 * method is absent: many tests install partial `window.octopusAPI` mocks, and the Linux
 * behaviour is the historical default.
 */
export function rendererOs(): OsProfile {
  const api = window.octopusAPI as Partial<typeof window.octopusAPI> | undefined
  return osProfile(typeof api?.getPlatform === 'function' ? toOsId(api.getPlatform()) : 'linux')
}
