/**
 * Clipboard port (DESIGN §2). The single edge over the OS clipboard, used by the
 * terminal's copy/paste (§5.4). Implemented by `ElectronClipboard` in the main
 * process; the renderer reaches it only through `window.octopusAPI.clipboard`
 * (the IPC layer wraps these synchronous calls in a Promise).
 */

export interface Clipboard {
  /** The clipboard's current plain text (empty string if none). */
  readText(): string
  /** Replace the clipboard's plain text. */
  writeText(text: string): void
}
