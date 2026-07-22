/**
 * Transport-agnostic IPC contract shared by main, preload and renderer
 * (DESIGN §6.5). Keeping the message set here — rather than inline in Electron
 * IPC calls — means the V2 durable-session daemon can carry the same protocol
 * over a Unix socket unchanged.
 *
 * V0 defines only a `ping` health-check to prove the contextBridge wiring works
 * end to end. The V1 command/event sets are enumerated below as the seam to fill.
 */

/** IPC channel names. One per request/reply command; streaming events added in V1. */
export const CHANNELS = {
  /** V0 health check: renderer → main → 'pong'. */
  ping: 'app:ping'
} as const

/**
 * The API surface exposed to the renderer via `window.octopusAPI`
 * (contextBridge, DESIGN §5.5). The renderer never touches ipcRenderer directly.
 */
export interface OctopusAPI {
  /** Round-trip health check; resolves to 'pong'. */
  ping(): Promise<string>
}

// ── V1 seam (DESIGN §6.5) — defined here when implemented, NOT yet wired ──────
//
// Commands (UI → backend), via ipcMain.handle with a renderer-generated requestId:
//   createTask, deleteTask{force?}, renameTask, reorderTask,
//   createSession, closeSession, renameSession, reorderSession,
//   writeToPty, resizePty, getState, updateSettings
//
// Events (backend → UI), via webContents.send:
//   ptyData, sessionCreated, sessionExited, sessionClosed,
//   taskCreated, taskDeleted, taskRenamed, taskStale, scriptProgress, scriptError, error
//
// Defined-but-dormant seams (emitted by nobody until V2, DESIGN §10 V1):
//   sessionStateChanged, taskStateChanged
