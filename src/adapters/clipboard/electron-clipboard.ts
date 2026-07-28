/**
 * `Clipboard` backed by Electron's main-process `clipboard` module (DESIGN §2).
 * Runs in the main process (behind the `clipboard:read`/`clipboard:write` IPC
 * handlers, §6.5) rather than `navigator.clipboard` in the renderer, whose
 * `readText()` is unreliable under the sandbox (`sandbox: true`, §5.5).
 */

import { clipboard } from 'electron'
import type { Clipboard } from '../../ports/clipboard'

export class ElectronClipboard implements Clipboard {
  readText(): string {
    return clipboard.readText()
  }

  writeText(text: string): void {
    clipboard.writeText(text)
  }
}
