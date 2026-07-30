/**
 * IPC command handlers (DESIGN §6.5). Registers one `ipcMain.handle` per
 * request/reply command and two `ipcMain.on` for the fire-and-forget PTY I/O.
 * Each handler maps the inbound wire DTO (string ids, `SessionConfigDTO`) to an
 * application `Command` (domain-branded ids, domain `SessionConfig`) and
 * dispatches it onto the single-writer loop, returning its `CommandResult` as a
 * `CommandAck` (§6.6). `getState` runs the read-model query and maps it to the
 * wire `WorkspaceStateDTO`.
 *
 * This is the inbound boundary: `main` is the only layer that may import both the
 * application/domain and `shared`, so the DTO→command rebranding happens here and
 * nowhere else. Handlers never throw to the renderer — the loop turns every domain
 * error into `{ ok: false, error }` (§7).
 *
 * `pty:write`/`pty:resize` use `on` (no reply): high-frequency keystrokes/resizes
 * must never head-of-line-block a command reply (§6.5). They still route THROUGH
 * the loop so their ordering relative to close/create is preserved (§6.6).
 */

import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { CHANNELS, type PtyWriteInput, type PtyResizeInput } from '../shared/ipc'
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
  SessionCwdInput,
  RefreshSessionStateInput,
  CreateWindowInput,
  CloseWindowInput,
  MoveSessionInput,
  CreateWindowWithSessionInput,
  WindowAtPointInput,
  SettingsPatchDTO,
  WindowedWorkspaceStateDTO
} from '../shared/dto'
import type { CommandLoop } from '../application/command-loop'
import type { Clipboard } from '../ports/clipboard'
import type { AppDependencies } from '../application/dependencies'
import type { CommandResult } from '../application/commands'
import type { SettingsPatch } from '../application/commands'
import { getState } from '../application/queries/get-state'
import { getSessionCwd } from '../application/queries/get-session-cwd'
import {
  asTaskId,
  asSessionId,
  asTypeId,
  asWindowId,
  MAIN_WINDOW_ID,
  type WindowId
} from '../domain/ids'
import { toWindowedWorkspaceStateDTO, toSessionConfig } from './dto-mappers'

function ack(result: CommandResult): CommandAck {
  return {
    ok: result.ok,
    needsDirtyConfirm: result.needsDirtyConfirm,
    error: result.error,
    windowId: result.windowId
  }
}

export interface IpcHandlerHooks {
  /**
   * webContents.id → WindowId (V1.5, §6.7). Shared with the composition root and
   * filled as windows open; lets `getState`/`windowAtPoint` resolve the calling or
   * pointed-at window from `e.sender` / the OS window list.
   */
  readonly windowIds: Map<number, WindowId>
  /**
   * Called when a window requests `getState` — its hydration call, made AFTER it
   * registered its `onEvent` listener. Wired to the registry's per-window
   * `markReady` so THAT window's buffered startup events flush exactly when it can
   * receive them (§6.7, generalizes the §6.5 single-window hydrate).
   */
  readonly onHydrate?: (windowId: WindowId) => void
  /** OS clipboard adapter backing the terminal copy/paste queries (§5.4). */
  readonly clipboard: Clipboard
}

/** Resolve the WindowId of the calling renderer (`e.sender`), defaulting to main. */
function senderWindowId(windowIds: Map<number, WindowId>, sender: Electron.WebContents): WindowId {
  return windowIds.get(sender.id) ?? MAIN_WINDOW_ID
}

/**
 * Register every IPC handler against the command loop + deps. Called once at the
 * end of bootstrap, before any window loads.
 */
export function registerIpcHandlers(
  loop: CommandLoop,
  deps: AppDependencies,
  hooks: IpcHandlerHooks
): void {
  // Health check (kept from V0).
  ipcMain.handle(CHANNELS.ping, () => 'pong')

  // ── Task commands ─────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.taskCreate, async (_e, input: CreateTaskInput): Promise<CommandAck> => {
    // The DTO and the application command share the same `mode`-discriminated
    // shape (all string fields, no branded ids), so forward it verbatim.
    const result = await loop.dispatch({ kind: 'createTask', input })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.taskDelete, async (_e, input: DeleteTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'deleteTask',
      input: {
        taskId: asTaskId(input.taskId),
        force: input.force,
        confirmedDirty: input.confirmedDirty
      }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.taskRename, async (_e, input: RenameTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'renameTask',
      input: { taskId: asTaskId(input.taskId), name: input.name }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.taskReorder, async (_e, input: ReorderTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'reorderTask',
      input: { taskId: asTaskId(input.taskId), toIndex: input.toIndex }
    })
    return ack(result)
  })

  ipcMain.handle(CHANNELS.taskSwitch, async (_e, input: SwitchTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'switchTask',
      input: { taskId: asTaskId(input.taskId) }
    })
    return ack(result)
  })

  // ── Session commands ──────────────────────────────────────────────────────
  ipcMain.handle(
    CHANNELS.sessionCreate,
    async (e, input: CreateSessionInput): Promise<CommandAck> => {
      // Host the new session in the window that asked for it (V1.5, §6.7). Resolve
      // the calling renderer the same way getState/windowAtPoint do — the renderer
      // needn't pass its own id over the wire.
      const windowId = senderWindowId(hooks.windowIds, e.sender)
      const result = await loop.dispatch({
        kind: 'createSession',
        input: {
          taskId: asTaskId(input.taskId),
          typeId: input.typeId !== undefined ? asTypeId(input.typeId) : undefined,
          title: input.title,
          config: input.config !== undefined ? toSessionConfig(input.config) : undefined,
          windowId
        }
      })
      return ack(result)
    }
  )

  ipcMain.handle(
    CHANNELS.sessionClose,
    async (_e, input: CloseSessionInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'closeSession',
        input: { sessionId: asSessionId(input.sessionId) }
      })
      return ack(result)
    }
  )

  ipcMain.handle(
    CHANNELS.sessionRename,
    async (_e, input: RenameSessionInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'renameSession',
        input: { sessionId: asSessionId(input.sessionId), title: input.title }
      })
      return ack(result)
    }
  )

  ipcMain.handle(
    CHANNELS.sessionReorder,
    async (_e, input: ReorderSessionInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'reorderSession',
        input: {
          taskId: asTaskId(input.taskId),
          sessionId: asSessionId(input.sessionId),
          toIndex: input.toIndex
        }
      })
      return ack(result)
    }
  )

  // ── Session move (V1.5, §3.7) ───────────────────────────────────────────────
  ipcMain.handle(CHANNELS.sessionMove, async (_e, input: MoveSessionInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'moveSessionToWindow',
      input: {
        sessionId: asSessionId(input.sessionId),
        targetWindowId: asWindowId(input.targetWindowId)
      }
    })
    return ack(result)
  })

  // A session's live cwd (query, bypasses the loop, §6.5). Reads the live runtime
  // handle straight from deps.runtimes; maps undefined → null for the wire. Powers
  // "new terminal from this directory".
  ipcMain.handle(CHANNELS.sessionCwd, async (_e, input: SessionCwdInput): Promise<string | null> => {
    const cwd = await getSessionCwd(deps, asSessionId(input.sessionId))
    return cwd ?? null
  })

  // ── Window commands (V1.5, §6.7) ────────────────────────────────────────────
  ipcMain.handle(
    CHANNELS.windowCreate,
    async (_e, input: CreateWindowInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'createWindow',
        input: { role: 'secondary', bounds: input.bounds }
      })
      return ack(result)
    }
  )

  ipcMain.handle(CHANNELS.windowClose, async (_e, input: CloseWindowInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'closeWindow',
      input: { windowId: asWindowId(input.windowId), disposition: input.disposition }
    })
    return ack(result)
  })

  ipcMain.handle(
    CHANNELS.windowCreateWithSession,
    async (_e, input: CreateWindowWithSessionInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'createWindowWithSession',
        input: { sessionId: asSessionId(input.sessionId), bounds: input.bounds }
      })
      return ack(result)
    }
  )

  // Hit-test a screen point against open windows (query, bypasses the loop, §6.7).
  // Returns the WindowId whose OS bounds contain the point, or null (empty desktop).
  ipcMain.handle(CHANNELS.windowAtPoint, (_e, input: WindowAtPointInput): string | null => {
    const point = { x: Math.round(input.x), y: Math.round(input.y) }
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !win.isVisible()) {
        continue
      }
      const b = win.getBounds()
      const inside =
        point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
      if (inside) {
        return hooks.windowIds.get(win.webContents.id) ?? null
      }
    }
    return null
  })

  // ── App-level ─────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.appGetState, (e): WindowedWorkspaceStateDTO => {
    // Resolve WHICH window is hydrating so we can stamp its identity + mark only it
    // ready (§6.7). Its role comes from the persisted window record (main by default).
    const windowId = senderWindowId(hooks.windowIds, e.sender)
    const view = getState(deps)
    const record = view.windows.find((w) => w.id === windowId)
    const role: 'main' | 'secondary' = record?.role ?? 'main'
    const dto = toWindowedWorkspaceStateDTO(view, windowId, role)
    // This window registered onEvent before the call; flush its buffered events.
    hooks.onHydrate?.(windowId)
    return dto
  })

  // The running app's release version (semver from package.json). Stateless query,
  // bypasses the command loop. Distinct from the feature-set version in the state DTO.
  ipcMain.handle(CHANNELS.appGetVersion, (): string => app.getVersion())

  ipcMain.handle(
    CHANNELS.appUpdateSettings,
    async (_e, patch: SettingsPatchDTO): Promise<CommandAck> => {
      // SettingsPatchDTO is structurally the application SettingsPatch.
      const result = await loop.dispatch({
        kind: 'updateSettings',
        input: patch as SettingsPatch
      })
      return ack(result)
    }
  )

  // Native directory picker for the New-Task modal (§5.4). A stateless query, so
  // it bypasses the command loop (like getState). Anchored to the requesting
  // window so the dialog is modal; `createDirectory` lets the user make a new repo
  // folder inline. Returns the chosen absolute path, or undefined on cancel.
  ipcMain.handle(CHANNELS.dialogPickDirectory, async (e): Promise<string | undefined> => {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory']
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return undefined
    }
    return result.filePaths[0]
  })

  // Clipboard read/write for terminal copy/paste (§5.4). Stateless queries over the
  // OS clipboard adapter, bypassing the command loop (like dialogPickDirectory).
  ipcMain.handle(CHANNELS.clipboardRead, (): string => hooks.clipboard.readText())
  ipcMain.handle(CHANNELS.clipboardWrite, (_e, text: string): void =>
    hooks.clipboard.writeText(text)
  )

  // ── Fire-and-forget PTY I/O (no reply, §6.5) ────────────────────────────────
  ipcMain.on(CHANNELS.ptyWrite, (_e, input: PtyWriteInput) => {
    void loop.dispatch({
      kind: 'writeToPty',
      input: { sessionId: asSessionId(input.sessionId), data: input.data }
    })
  })

  ipcMain.on(CHANNELS.ptyResize, (_e, input: PtyResizeInput) => {
    void loop.dispatch({
      kind: 'resizePty',
      input: { sessionId: asSessionId(input.sessionId), cols: input.cols, rows: input.rows }
    })
  })

  // Manual state refresh (§5.4 R1): fire-and-forget, like PTY I/O. The refreshed
  // state, if any, surfaces asynchronously as a `sessionStateChanged` event.
  ipcMain.on(CHANNELS.sessionRefreshState, (_e, input: RefreshSessionStateInput) => {
    void loop.dispatch({
      kind: 'refreshSessionState',
      input: { sessionId: asSessionId(input.sessionId) }
    })
  })
}
