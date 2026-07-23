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

import { ipcMain, dialog, BrowserWindow } from 'electron'
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
  SettingsPatchDTO,
  WorkspaceStateDTO
} from '../shared/dto'
import type { CommandLoop } from '../application/command-loop'
import type { AppDependencies } from '../application/dependencies'
import type { CommandResult } from '../application/commands'
import type { SettingsPatch } from '../application/commands'
import { getState } from '../application/queries/get-state'
import { asTaskId, asSessionId, asTypeId } from '../domain/ids'
import { toWorkspaceStateDTO, toSessionConfig } from './dto-mappers'

function ack(result: CommandResult): CommandAck {
  return { ok: result.ok, needsDirtyConfirm: result.needsDirtyConfirm, error: result.error }
}

export interface IpcHandlerHooks {
  /**
   * Called each time the renderer requests `getState` — its hydration call, made
   * AFTER it has registered its `onEvent` listener. `window.ts` wires this to the
   * event-forwarder's `markReady` so buffered startup events (e.g. reconciliation
   * `taskStale`) flush exactly when the renderer can receive them (§6.5).
   */
  readonly onHydrate?: () => void
}

/**
 * Register every IPC handler against the command loop + deps. Called once at the
 * end of bootstrap, before any window loads.
 */
export function registerIpcHandlers(
  loop: CommandLoop,
  deps: AppDependencies,
  hooks: IpcHandlerHooks = {}
): void {
  // Health check (kept from V0).
  ipcMain.handle(CHANNELS.ping, () => 'pong')

  // ── Task commands ─────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.taskCreate, async (_e, input: CreateTaskInput): Promise<CommandAck> => {
    const result = await loop.dispatch({
      kind: 'createTask',
      input: {
        name: input.name,
        repoDir: input.repoDir,
        sourceBranch: input.sourceBranch,
        newBranch: input.newBranch
      }
    })
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
    async (_e, input: CreateSessionInput): Promise<CommandAck> => {
      const result = await loop.dispatch({
        kind: 'createSession',
        input: {
          taskId: asTaskId(input.taskId),
          typeId: input.typeId !== undefined ? asTypeId(input.typeId) : undefined,
          title: input.title,
          config: input.config !== undefined ? toSessionConfig(input.config) : undefined
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

  // ── App-level ─────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.appGetState, (): WorkspaceStateDTO => {
    const dto = toWorkspaceStateDTO(getState(deps))
    // The renderer has registered onEvent before this call; let the forwarder
    // start flushing buffered startup events now (§6.5).
    hooks.onHydrate?.()
    return dto
  })

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
}
