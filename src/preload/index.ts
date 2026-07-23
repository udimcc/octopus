/**
 * The single typed bridge between renderer and main (DESIGN §5.5, §6.5). The
 * renderer never touches `ipcRenderer` or Node directly — everything goes through
 * this `window.octopusAPI`. Commands use `invoke` (request/reply → `CommandAck`);
 * PTY I/O uses `send` (fire-and-forget, high-frequency, §6.5); `onEvent` subscribes
 * to the single `app:event` stream and returns an unsubscribe fn.
 *
 * `contextIsolation` is on and `ipcRenderer` is NOT leaked — only these narrow,
 * typed functions cross the bridge (§5.5).
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type OctopusAPI, type PtyWriteInput, type PtyResizeInput } from '../shared/ipc'
import type {
  CommandAck,
  CreateTaskInput,
  DeleteTaskInput,
  RenameTaskInput,
  ReorderTaskInput,
  SwitchTaskInput,
  CreateSessionInput,
  CloseSessionInput,
  RenameSessionInput,
  ReorderSessionInput,
  SettingsPatchDTO,
  WorkspaceStateDTO
} from '../shared/dto'
import type { EventDTO } from '../shared/events'

const octopusAPI: OctopusAPI = {
  ping: () => ipcRenderer.invoke(CHANNELS.ping),

  tasks: {
    create: (input: CreateTaskInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.taskCreate, input),
    delete: (input: DeleteTaskInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.taskDelete, input),
    rename: (input: RenameTaskInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.taskRename, input),
    reorder: (input: ReorderTaskInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.taskReorder, input),
    switch: (input: SwitchTaskInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.taskSwitch, input)
  },

  sessions: {
    create: (input: CreateSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.sessionCreate, input),
    close: (input: CloseSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.sessionClose, input),
    rename: (input: RenameSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.sessionRename, input),
    reorder: (input: ReorderSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.sessionReorder, input)
  },

  pty: {
    write: (input: PtyWriteInput): void => ipcRenderer.send(CHANNELS.ptyWrite, input),
    resize: (input: PtyResizeInput): void => ipcRenderer.send(CHANNELS.ptyResize, input)
  },

  app: {
    getState: (): Promise<WorkspaceStateDTO> => ipcRenderer.invoke(CHANNELS.appGetState),
    updateSettings: (patch: SettingsPatchDTO): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.appUpdateSettings, patch)
  },

  dialog: {
    pickDirectory: (): Promise<string | undefined> =>
      ipcRenderer.invoke(CHANNELS.dialogPickDirectory)
  },

  onEvent: (handler: (event: EventDTO) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: EventDTO): void => handler(event)
    ipcRenderer.on(CHANNELS.event, listener)
    return () => ipcRenderer.removeListener(CHANNELS.event, listener)
  }
}

contextBridge.exposeInMainWorld('octopusAPI', octopusAPI)
