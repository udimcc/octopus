/**
 * Electron wraps a rejected IPC handler's error as
 * `Error invoking remote method '<channel>': Error: <message>` — strip that
 * boilerplate so the renderer only shows the original message. Shared by every
 * caller that attaches a rejection arm to a `window.octopusAPI.*` promise
 * (`IssueDetail`, `NewTaskModal`, `LinkTaskPicker`, `DeleteTaskConfirm`); this
 * used to be copy-pasted locally in each of those files.
 */
export function cleanIpcError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}
