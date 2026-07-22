/// <reference types="vite/client" />

import type { OctopusAPI } from '../../shared/ipc'

// The preload exposes window.octopusAPI; make it visible to the renderer's
// type-checker (tsconfig.web.json does not include src/preload).
declare global {
  interface Window {
    octopusAPI: OctopusAPI
  }
}

export {}
