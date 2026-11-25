/**
 * Application menu template (pure, no Electron runtime import — only its types).
 *
 * `'none'` (Linux, Windows): no menu at all (`null`); Octopus is driven entirely through the renderer UI.
 *
 * `'minimal'` (macOS): the menu bar always exists there, and without an Edit menu the standard
 * Cmd+C/V/X/A/Z shortcuts do nothing in text inputs (Electron wires them through
 * menu roles). So darwin gets a minimal menu: the app menu, Edit and Window. It
 * deliberately has NO View menu (no reload / devtools accelerators that would wipe
 * terminal state) and NO `close` role (Cmd+W belongs to the renderer's shortcuts;
 * closing main quits the app via `window.ts`). `quit` (Cmd+Q) calls `app.quit()`,
 * which runs the same `before-quit` path as every other quit (busy-sessions prompt,
 * scrollback flush; `registerQuitHandler` in `window.ts`).
 */

import type { MenuItemConstructorOptions } from 'electron'
import type { AppMenuKind } from '../shared/os'

/** `kind` is the OS profile's `app.appMenu`. */
export function appMenuTemplate(
  kind: AppMenuKind,
  appName: string
): MenuItemConstructorOptions[] | null {
  if (kind === 'none') {
    return null
  }
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }]
    }
  ]
}
