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
  SwitchSessionInput,
  FocusSessionInput,
  RenameSessionInput,
  ReorderSessionInput,
  SessionCwdInput,
  RefreshSessionStateInput,
  MarkSessionSeenInput,
  CreateWindowInput,
  CloseWindowInput,
  MoveSessionInput,
  CreateWindowWithSessionInput,
  WindowAtPointInput,
  SettingsPatchDTO,
  WindowedWorkspaceStateDTO,
  ProjectListItemDTO,
  ProjectWorktreeDTO,
  AddProjectInput,
  RemoveProjectInput,
  SetProjectDefaultBranchInput,
  ListProjectWorktreesInput
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
    switch: (input: SwitchSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.sessionSwitch, input),
    rename: (input: RenameSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.sessionRename, input),
    reorder: (input: ReorderSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.sessionReorder, input),
    move: (input: MoveSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.sessionMove, input),
    cwd: (input: SessionCwdInput): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.sessionCwd, input),
    refreshState: (input: RefreshSessionStateInput): void =>
      ipcRenderer.send(CHANNELS.sessionRefreshState, input),
    markSeen: (input: MarkSessionSeenInput): void =>
      ipcRenderer.send(CHANNELS.sessionMarkSeen, input),
    focus: (input: FocusSessionInput): void => ipcRenderer.send(CHANNELS.sessionFocus, input)
  },

  windows: {
    create: (input: CreateWindowInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.windowCreate, input),
    close: (input: CloseWindowInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.windowClose, input),
    createWithSession: (input: CreateWindowWithSessionInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.windowCreateWithSession, input),
    windowAtPoint: (input: WindowAtPointInput): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.windowAtPoint, input)
  },

  pty: {
    write: (input: PtyWriteInput): void => ipcRenderer.send(CHANNELS.ptyWrite, input),
    resize: (input: PtyResizeInput): void => ipcRenderer.send(CHANNELS.ptyResize, input)
  },

  app: {
    getState: (): Promise<WindowedWorkspaceStateDTO> => ipcRenderer.invoke(CHANNELS.appGetState),
    updateSettings: (patch: SettingsPatchDTO): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.appUpdateSettings, patch),
    // Synchronous, no IPC (V1.5, §5.6): each window is loaded with a `?windowId=`
    // query param (see `main/window.ts`); the sandboxed preload can read
    // `window.location` directly. Absent param → the main window's id.
    getWindowId: (): string =>
      new URLSearchParams(
        (globalThis as unknown as { location: { search: string } }).location.search
      ).get('windowId') ?? 'main',
    getVersion: (): Promise<string> => ipcRenderer.invoke(CHANNELS.appGetVersion)
  },

  dialog: {
    pickDirectory: (): Promise<string | undefined> =>
      ipcRenderer.invoke(CHANNELS.dialogPickDirectory)
  },

  projects: {
    list: (): Promise<readonly ProjectListItemDTO[]> => ipcRenderer.invoke(CHANNELS.projectList),
    add: (input: AddProjectInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.projectAdd, input),
    remove: (input: RemoveProjectInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.projectRemove, input),
    setDefaultBranch: (input: SetProjectDefaultBranchInput): Promise<CommandAck> =>
      ipcRenderer.invoke(CHANNELS.projectSetDefaultBranch, input),
    listWorktrees: (input: ListProjectWorktreesInput): Promise<readonly ProjectWorktreeDTO[]> =>
      ipcRenderer.invoke(CHANNELS.projectListWorktrees, input)
  },

  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke(CHANNELS.clipboardRead),
    write: (text: string): Promise<void> => ipcRenderer.invoke(CHANNELS.clipboardWrite, text)
  },

  onEvent: (handler: (event: EventDTO) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: EventDTO): void => handler(event)
    ipcRenderer.on(CHANNELS.event, listener)
    return () => ipcRenderer.removeListener(CHANNELS.event, listener)
  }
}

contextBridge.exposeInMainWorld('octopusAPI', octopusAPI)
