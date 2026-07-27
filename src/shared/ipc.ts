/**
 * Transport-agnostic IPC contract shared by main, preload and renderer
 * (DESIGN §6.5). Keeping the message set here — rather than inline in Electron
 * IPC calls — means the V2 durable-session daemon can carry the same protocol
 * over a Unix socket unchanged.
 *
 * Two channel shapes (§6.5):
 *   - request/reply COMMANDS (`ipcMain.handle` ↔ `ipcRenderer.invoke`): every
 *     mutation + `getState`; each resolves to a `CommandAck` (or the state DTO).
 *   - fire-and-forget: `pty:write`/`pty:resize` (renderer → main, `send`) and the
 *     single `app:event` stream (main → renderer, `webContents.send`). Streaming
 *     `ptyData` uses `send` so high-frequency output never head-of-line-blocks a
 *     command reply (§6.5).
 */

import type {
  WindowedWorkspaceStateDTO,
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
  CreateWindowInput,
  CloseWindowInput,
  MoveSessionInput,
  CreateWindowWithSessionInput,
  WindowAtPointInput,
  SettingsPatchDTO
} from './dto'
import type { EventDTO } from './events'

/** IPC channel names. One per request/reply command; one shared event stream. */
export const CHANNELS = {
  /** V0 health check: renderer → main → 'pong'. */
  ping: 'app:ping',

  // Task commands (UI → backend, request/reply).
  taskCreate: 'task:create',
  taskDelete: 'task:delete',
  taskRename: 'task:rename',
  taskReorder: 'task:reorder',
  taskSwitch: 'task:switch',

  // Session commands (UI → backend, request/reply).
  sessionCreate: 'session:create',
  sessionClose: 'session:close',
  sessionRename: 'session:rename',
  sessionReorder: 'session:reorder',
  sessionMove: 'session:move',

  // Window commands (UI → backend, request/reply) (V1.5, §6.7).
  windowCreate: 'window:create',
  windowClose: 'window:close',
  windowCreateWithSession: 'window:createWithSession',

  // PTY I/O (UI → backend, fire-and-forget: high-frequency, no reply).
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',

  // App-level (request/reply).
  appGetState: 'app:getState',
  appUpdateSettings: 'app:updateSettings',

  /**
   * Native directory picker (request/reply). A stateless main-side QUERY — like
   * `getState`, it does NOT go through the command loop (§6.5). Resolves to the
   * chosen absolute path, or `undefined` if the user cancelled.
   */
  dialogPickDirectory: 'dialog:pickDirectory',

  /**
   * Hit-test a screen-space point against the open windows (request/reply). Like
   * `dialogPickDirectory`, a stateless main-side QUERY that bypasses the command
   * loop (§6.7). Resolves to the `windowId` under the point, or `null` if none.
   */
  windowAtPoint: 'window:atPoint',

  /**
   * The calling renderer's own window id (request/reply). Serviced SYNCHRONOUSLY
   * in preload from `?windowId=` — this channel exists for contract completeness;
   * the preload never actually round-trips it (§5.6).
   */
  appGetWindowId: 'app:getWindowId',

  /** Streaming events (backend → UI, webContents.send). Carries a discriminated EventDTO. */
  event: 'app:event'
} as const

/** Payload of a `pty:write` message. */
export interface PtyWriteInput {
  readonly sessionId: string
  readonly data: string
}

/** Payload of a `pty:resize` message. */
export interface PtyResizeInput {
  readonly sessionId: string
  readonly cols: number
  readonly rows: number
}

/**
 * The API surface exposed to the renderer via `window.octopusAPI`
 * (contextBridge, DESIGN §5.5). The renderer never touches ipcRenderer directly.
 * Grouped by concern; commands resolve to a `CommandAck` unless noted.
 */
export interface OctopusAPI {
  /** Round-trip health check; resolves to 'pong'. */
  ping(): Promise<string>

  tasks: {
    create(input: CreateTaskInput): Promise<CommandAck>
    delete(input: DeleteTaskInput): Promise<CommandAck>
    rename(input: RenameTaskInput): Promise<CommandAck>
    reorder(input: ReorderTaskInput): Promise<CommandAck>
    switch(input: SwitchTaskInput): Promise<CommandAck>
  }

  sessions: {
    create(input: CreateSessionInput): Promise<CommandAck>
    close(input: CloseSessionInput): Promise<CommandAck>
    rename(input: RenameSessionInput): Promise<CommandAck>
    reorder(input: ReorderSessionInput): Promise<CommandAck>
    /** Reassign a session to another open window (V1.5, §3.7). */
    move(input: MoveSessionInput): Promise<CommandAck>
  }

  /** Multi-window control (V1.5, §5.6, §6.7). */
  windows: {
    /** Open a new secondary window; the ack carries its new `windowId`. */
    create(input: CreateWindowInput): Promise<CommandAck>
    /** Close a secondary window, deciding its live sessions' fate. */
    close(input: CloseWindowInput): Promise<CommandAck>
    /** Atomically open a new secondary window hosting a detached session. */
    createWithSession(input: CreateWindowWithSessionInput): Promise<CommandAck>
    /** Hit-test a screen point → the `windowId` under it, or `null` (query). */
    windowAtPoint(input: WindowAtPointInput): Promise<string | null>
  }

  pty: {
    /** Fire-and-forget keystrokes to a session's PTY. */
    write(input: PtyWriteInput): void
    /** Fire-and-forget resize (debounced in the renderer). */
    resize(input: PtyResizeInput): void
  }

  app: {
    /**
     * Full workspace snapshot for hydration on startup (§5.2). Resolves to a
     * {@link WindowedWorkspaceStateDTO} (V1.5): the base state plus this window's
     * identity and the window list. Pre-V1.5 callers reading only
     * {@link WorkspaceStateDTO} fields keep working (the type widens additively).
     */
    getState(): Promise<WindowedWorkspaceStateDTO>
    updateSettings(patch: SettingsPatchDTO): Promise<CommandAck>
    /**
     * This renderer's own window id (V1.5, §5.6). SYNCHRONOUS — the only
     * non-Promise method: preload reads `?windowId=` from the window URL, so no
     * IPC round-trip is needed. Defaults to `'main'` if the param is absent.
     */
    getWindowId(): string
  }

  dialog: {
    /**
     * Open a native folder picker for the New-Task modal (§5.4). Resolves to the
     * chosen absolute directory path, or `undefined` if the user cancelled.
     */
    pickDirectory(): Promise<string | undefined>
  }

  /** Subscribe to the backend event stream; returns an unsubscribe fn (§5.2). */
  onEvent(handler: (event: EventDTO) => void): () => void
}
