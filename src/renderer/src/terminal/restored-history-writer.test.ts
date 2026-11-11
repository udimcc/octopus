/**
 * The pane writer puts what follows restored history below the old content, with a
 * visible cursor, wherever a killed TUI left the terminal (real xterm, no DOM needed).
 */
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { createTerminalWriter } from './restored-history-writer'
import {
  RESTORED_HISTORY_END as END,
  historySizeMarker as size
} from '../../../shared/restored-history'

/** A 40×12 terminal whose "pane" refits it back to 40×12. */
function setup(): {
  term: Terminal
  write: (d: string) => void
  replaying: () => boolean
  refit: ReturnType<typeof vi.fn>
} {
  const term = new Terminal({ cols: 40, rows: 12, allowProposedApi: true })
  const refit = vi.fn(() => term.resize(40, 12))
  const writer = createTerminalWriter(term, refit)
  return { term, write: writer.write, replaying: writer.replaying, refit }
}

/** Let xterm parse everything queued, including what the marker's callback writes. */
async function settle(term: Terminal): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => term.write('', r))
}

function lines(term: Terminal): string[] {
  const b = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)!.translateToString(true).trimEnd())
  while (out.length && !out[out.length - 1]) out.pop()
  return out
}

const cursorHidden = (term: Terminal): boolean =>
  (term as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core.coreService
    .isCursorHidden

describe('createTerminalWriter', () => {
  it('passes plain output straight through', async () => {
    const { term, write } = setup()
    write('hello\r\nworld')
    await settle(term)
    expect(lines(term)).toEqual(['hello', 'world'])
  })

  it('puts what follows below a TUI frame the cursor was parked inside, cursor shown', async () => {
    const { term, write } = setup()
    // Claude-like: output, an input box and a 2-line footer, cursor back up in the box.
    write('answer\r\n> \r\n───\r\nstatus 1\r\nstatus 2\x1b[3A\x1b[3G\x1b[?25l')
    write(`${END}\r\nRESTORED\r\n$ `)
    await settle(term)
    expect(lines(term)).toEqual(['answer', '>', '───', 'status 1', 'status 2', 'RESTORED', '$'])
    expect(cursorHidden(term)).toBe(false)
  })

  it('adds no gap when the cursor is already on the last line', async () => {
    const { term, write } = setup()
    write(`$ ls\r\na b\r\n$ ${END}\r\nRESTORED`)
    await settle(term)
    expect(lines(term)).toEqual(['$ ls', 'a b', '$', 'RESTORED'])
  })

  it('keeps output that arrives before the marker is handled after it', async () => {
    const { term, write } = setup()
    write(`frame\r\nfooter\x1b[A${END}\r\nRESTORED\r\n`)
    write('LIVE')
    await settle(term)
    expect(lines(term)).toEqual(['frame', 'footer', 'RESTORED', 'LIVE'])
  })

  it('leaves the alternate screen of a killed full-screen program', async () => {
    const { term, write } = setup()
    write('$ vim\r\n\x1b[?1049h\x1b[Hvim screen\x1b[5;1H~')
    write(`${END}\r\nRESTORED`)
    await settle(term)
    expect(term.buffer.active.type).toBe('normal')
    // Back where vim started (the line under its command), as a real terminal would be.
    expect(lines(term)).toEqual(['$ vim', '', 'RESTORED'])
  })

  it('resets a stale scroll region so what follows is not trapped in it', async () => {
    const { term, write } = setup()
    write('top\r\n\x1b[1;3r\x1b[2;1Hin region')
    write(`${END}\r\nA\r\nB\r\nC`)
    await settle(term)
    expect(lines(term)).toEqual(['top', 'in region', 'A', 'B', 'C'])
  })

  it('parses history at its recorded width, then refits the pane', async () => {
    const { term, write, replaying, refit } = setup()
    // Recorded at 60 columns: a word placed at column 50 with an absolute move. At the
    // pane's 40 it would clamp onto column 40 and overwrite "left".
    write(`${size(60, 12)}left\x1b[50Gright\r\n`)
    await settle(term)
    expect(term.cols).toBe(60)
    expect(replaying()).toBe(true)
    write(`${END}\r\nRESTORED`)
    await settle(term)
    expect(refit).toHaveBeenCalledTimes(1)
    expect(replaying()).toBe(false)
    expect(term.cols).toBe(40)
    // Reflowed to 40 like a live terminal on resize: "right" (column 50) wraps onto the
    // next row. xterm never reflows the cursor's row, which is why history ending on
    // its content would stay cut; restored history ends below it.
    expect(lines(term)).toEqual(['left', ' '.repeat(9) + 'right', '', 'RESTORED'])
  })

  it('follows a size change inside the history', async () => {
    const { term, write } = setup()
    write(`${size(30, 12)}a\x1b[25Gb\r\n${size(50, 12)}c\x1b[45Gd\r\n`)
    write(END)
    await settle(term)
    expect(lines(term)).toEqual(['a' + ' '.repeat(23) + 'b', 'c', ' '.repeat(4) + 'd'])
  })

  it('ignores an unknown marker body', async () => {
    const { term, write } = setup()
    write('a\x1b]7764;octopus-bogus\x07b')
    await settle(term)
    expect(lines(term)).toEqual(['ab'])
  })
})
