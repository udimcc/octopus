import type { OctopusAPI } from '../shared/ipc'

// Makes window.octopusAPI visible to the renderer's type-checker.
declare global {
  interface Window {
    octopusAPI: OctopusAPI
  }
}

export {}
