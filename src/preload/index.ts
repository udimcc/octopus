import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type OctopusAPI } from '../shared/ipc'

// The single, typed bridge between renderer and main (DESIGN §5.5). The renderer
// never touches ipcRenderer or Node directly — everything goes through this API.
const octopusAPI: OctopusAPI = {
  ping: () => ipcRenderer.invoke(CHANNELS.ping)
}

contextBridge.exposeInMainWorld('octopusAPI', octopusAPI)
