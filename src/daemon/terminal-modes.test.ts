import { describe, it, expect } from 'vitest'
import { TerminalModeTracker } from './terminal-modes'

describe('TerminalModeTracker', () => {
  it('emits nothing for a session that never changed a mode', () => {
    const t = new TerminalModeTracker()
    t.observe('$ ls\r\nfile-a  file-b\r\n')
    expect(t.restoreSequence()).toBe('')
  })

  it('emits nothing for coloured output (SGR is transient, not sticky)', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[1;32muser@host\x1b[0m:\x1b[34m~/x\x1b[0m$ ')
    expect(t.restoreSequence()).toBe('')
  })

  /**
   * The `emacsclient -nw` case: terminfo `smcup` + `smkx` at startup, evicted from the
   * ring buffer days ago. Without this the re-attached terminal sends `ESC [ A` for Up
   * while emacs decodes `ESC O A`, and the program paints into the normal buffer.
   */
  it('restores the alternate screen and application keys a TUI set at startup', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?1049h\x1b[?1h\x1b=\x1b[?2004h\x1b[2J\x1b[H-*- scratch -*-')
    expect(t.restoreSequence()).toBe('\x1b=\x1b[?1h\x1b[?2004h\x1b[?1049h')
  })

  it('puts the screen switch LAST so replayed scrollback stays in the normal buffer', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?1049h\x1b[?1000h')
    const restore = t.restoreSequence()
    expect(restore.indexOf('\x1b[?1000h')).toBeLessThan(restore.indexOf('\x1b[?1049h'))
  })

  it('handles multi-parameter DECSET (mouse enabling in one sequence)', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?1000;1002;1006;1015h')
    expect(t.restoreSequence()).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1015h')
  })

  it('tracks the LAST value: a mode set then reset is back at its default', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?1049h\x1b[?1h\x1b=')
    t.observe('\x1b[?1049l\x1b[?1l\x1b>')
    expect(t.restoreSequence()).toBe('\x1b>')
    expect(t.onAlternateScreen).toBe(false)
  })

  it('restores a non-default OFF for a mode that defaults ON', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?25l\x1b[?7l') // hidden cursor, autowrap off
    expect(t.restoreSequence()).toBe('\x1b[?7l\x1b[?25l')
  })

  it('ignores modes it does not model (scroll region, origin, …)', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?6h\x1b[?69h\x1b[?1070h')
    expect(t.restoreSequence()).toBe('')
  })

  it('recognizes a sequence split across chunk boundaries, in every position', () => {
    const whole = '\x1b[?1049h'
    for (let cut = 1; cut < whole.length; cut++) {
      const t = new TerminalModeTracker()
      t.observe(whole.slice(0, cut))
      t.observe(whole.slice(cut))
      expect(t.restoreSequence(), `split at ${cut}`).toBe('\x1b[?1049h')
    }
  })

  it('recognizes a split DECKPAM', () => {
    const t = new TerminalModeTracker()
    t.observe('text\x1b')
    t.observe('=more')
    expect(t.restoreSequence()).toBe('\x1b=')
  })

  it('does not count a completed sequence twice across chunks', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?1049h')
    t.observe('\x1b[?1049l')
    expect(t.onAlternateScreen).toBe(false)
    expect(t.restoreSequence()).toBe('')
  })

  it('does not carry an unbounded tail after a bare ESC storm', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?1049h' + 'x'.repeat(200))
    t.observe('\x1b[?1h')
    expect(t.restoreSequence()).toBe('\x1b[?1h\x1b[?1049h')
  })

  it('reports alternate-screen state for the legacy variants too', () => {
    const t = new TerminalModeTracker()
    t.observe('\x1b[?47h')
    expect(t.onAlternateScreen).toBe(true)
  })

  it('ignores an empty chunk', () => {
    const t = new TerminalModeTracker()
    t.observe('')
    expect(t.restoreSequence()).toBe('')
  })
})
