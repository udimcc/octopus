/**
 * Incremental line splitter for streamed child-process output. Pure and
 * stateful-by-instance (no I/O), so the runner's line-buffering is unit-testable
 * without spawning anything. Handles chunk boundaries that split a line, strips a
 * trailing `\r` (CRLF), and flushes a final unterminated line on `end()`.
 */
export class LineSplitter {
  private buf = ''
  private readonly onLine: (line: string) => void

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine
  }

  /** Feed a chunk; emits every complete line it now contains. */
  push(chunk: string): void {
    this.buf += chunk
    let nl = this.buf.indexOf('\n')
    while (nl !== -1) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      this.onLine(stripCr(line))
      nl = this.buf.indexOf('\n')
    }
  }

  /** Emit any trailing partial line (no newline) and reset. */
  end(): void {
    if (this.buf.length > 0) {
      this.onLine(stripCr(this.buf))
      this.buf = ''
    }
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
