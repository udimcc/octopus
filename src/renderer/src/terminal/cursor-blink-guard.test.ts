/**
 * These tests run against the REAL `@xterm/xterm`, deliberately — the whole point of the
 * guard is what xterm does with `ESC[?12h`, so a mock would assert nothing. That works in
 * jsdom as long as we never call `term.open()` (no renderer, no canvas): the parser and
 * `OptionsService` are pure enough. `TerminalPane.test.tsx` keeps its own xterm mock;
 * `vi.mock` is per-file, so the two coexist.
 *
 * What actually matters is the NUMBER OF `cursorBlink` OPTION EVENTS, since each one costs a
 * ~55 KB stylesheet reparse plus two forced layouts in Blink (see the guard's header). xterm
 * publishes `onOptionChange` only on the internal `IOptionsService`, so these tests reach
 * through `term._core` to count them — an undeclared field, acceptable in a test and
 * canaried below, and the only way to measure the thing the fix exists for. Asserting on
 * `term.options.cursorBlink` instead would be a trap: that is a separate `_publicOptions`
 * object, so an earlier version of this guard "passed" by pinning a getter while every
 * expensive write still happened.
 *
 * Writes are awaited via `write(data, cb)` — parsing is asynchronous, so asserting straight
 * after `write()` would race.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installCursorBlinkGuard, isCursorBlinkOnlyDecMode } from './cursor-blink-guard'

/** The one verbatim repaint frame captured from Emacs (`cnorm` then `cvvis`), §5.3. */
const EMACS_REPAINT = '\x1b[28;6H\x1b[?12l\x1b[?25h\x1b[?12;25h\x1b[136;2H\x1b[?25l'

interface XtermCore {
  _core: {
    options: Record<string, unknown>
    optionsService: {
      onOptionChange(cb: (name: string) => void): { dispose(): void }
    }
  }
}

let term: Terminal | null = null

function makeTerm(options: ConstructorParameters<typeof Terminal>[0] = {}): Terminal {
  term = new Terminal(options)
  return term
}

function write(t: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve))
}

/** Count `cursorBlink` option changes — i.e. render-cascade triggers — while `body` runs. */
async function countBlinkEvents(t: Terminal, body: () => Promise<void>): Promise<number> {
  let events = 0
  const sub = (t as unknown as XtermCore)._core.optionsService.onOptionChange((name) => {
    if (name === 'cursorBlink') {
      events++
    }
  })
  try {
    await body()
  } finally {
    sub.dispose()
  }
  return events
}

/** The REAL option value (not the public mirror). */
function rawBlink(t: Terminal): unknown {
  return (t as unknown as XtermCore)._core.options.cursorBlink
}

afterEach(() => {
  term?.dispose()
  term = null
})

describe('isCursorBlinkOnlyDecMode', () => {
  it('matches mode 12 alone', () => {
    expect(isCursorBlinkOnlyDecMode([12])).toBe(true)
  })

  it('does not match anything else — those must fall through to xterm', () => {
    expect(isCursorBlinkOnlyDecMode([12, 25])).toBe(false) // combined: 25 must still apply
    expect(isCursorBlinkOnlyDecMode([25, 12])).toBe(false)
    expect(isCursorBlinkOnlyDecMode([12, [1]])).toBe(false) // sub-parameters (`?12:1h`)
    expect(isCursorBlinkOnlyDecMode([25])).toBe(false)
    expect(isCursorBlinkOnlyDecMode([0])).toBe(false) // bare `ESC[?h`
    expect(isCursorBlinkOnlyDecMode([])).toBe(false)
  })
})

describe('installCursorBlinkGuard (real xterm)', () => {
  it('CONTROL: without the guard, an alternating stream fires one event per toggle', async () => {
    const t = makeTerm()
    const events = await countBlinkEvents(t, async () => {
      for (let i = 0; i < 10; i++) {
        await write(t, '\x1b[?12h')
        await write(t, '\x1b[?12l')
      }
    })
    expect(events).toBe(20) // 20 stylesheet rebuilds — the crash, in miniature
  })

  it('swallows a pure-mode-12 stream entirely: zero option events, option unmoved', async () => {
    const t = makeTerm()
    installCursorBlinkGuard(t)
    const events = await countBlinkEvents(t, async () => {
      for (let i = 0; i < 10; i++) {
        await write(t, '\x1b[?12h')
        await write(t, '\x1b[?12l')
      }
    })
    expect(events).toBe(0)
    expect(rawBlink(t)).toBe(false)
  })

  it('THE REGRESSION: the captured Emacs repaint costs 199 events unguarded, 1 guarded', async () => {
    const unguarded = makeTerm()
    const before = await countBlinkEvents(unguarded, async () => {
      for (let i = 0; i < 100; i++) {
        await write(unguarded, EMACS_REPAINT)
      }
    })
    unguarded.dispose()

    const guarded = makeTerm()
    installCursorBlinkGuard(guarded)
    const after = await countBlinkEvents(guarded, async () => {
      for (let i = 0; i < 100; i++) {
        await write(guarded, EMACS_REPAINT)
      }
    })

    // Two writes per repaint (`cnorm`'s `?12l`, then `cvvis`'s combined `?12;25h`) alternate,
    // so nothing dedupes: 199 rebuilds × every mounted pane × a whole replayed ring buffer.
    expect(before).toBe(199)
    // Guarded, the `?12l` half is swallowed, so the combined raise lands ONCE and
    // `OptionsService` dedupes all 99 repeats. The residual `true` is documented, not a bug.
    expect(after).toBe(1)
    expect(rawBlink(guarded)).toBe(true)
  })

  it('leaves every other DEC private mode alone', async () => {
    const t = makeTerm()
    installCursorBlinkGuard(t)
    await write(t, '\x1b[?2004h') // bracketed paste
    expect(t.modes.bracketedPasteMode).toBe(true)
    await write(t, '\x1b[?1000h') // mouse tracking (TerminalPane reads this for §5.4)
    expect(t.modes.mouseTrackingMode).toBe('vt200')
    await write(t, '\x1b[?1h') // application cursor keys
    expect(t.modes.applicationCursorKeysMode).toBe(true)
    // DECRST (`?l`) is guarded too, so prove a non-12 reset still reaches xterm.
    await write(t, '\x1b[?2004l')
    expect(t.modes.bracketedPasteMode).toBe(false)
    await write(t, '\x1b[?7l') // wraparound
    expect(t.modes.wraparoundMode).toBe(false)
    // Cursor visibility (`?25h/l`) is a core-service MODE, not an option, so it never fired
    // the stylesheet rebuild and needs no guard — xterm exposes no public getter for it
    // (there is no `modes.cursorVisible` in 5.5), hence no assertion here.
  })

  it('passes a COMBINED sequence through so its other modes still apply', async () => {
    const t = makeTerm()
    installCursorBlinkGuard(t)
    await write(t, '\x1b[?12;1000h')
    expect(t.modes.mouseTrackingMode).toBe('vt200') // not swallowed
    expect(rawBlink(t)).toBe(true) // the accepted residual: one raise, then deduped
  })

  it('survives a full reset — RIS and DECSTR do not drop the handlers', async () => {
    const t = makeTerm()
    installCursorBlinkGuard(t)
    const events = await countBlinkEvents(t, async () => {
      await write(t, '\x1bc') // RIS
      await write(t, '\x1b[?12h')
      await write(t, '\x1b[!p') // DECSTR (soft reset)
      await write(t, '\x1b[?12h')
    })
    expect(events).toBe(0)
  })

  it('CANARY: `_core.optionsService.onOptionChange` is how these tests measure the fix', () => {
    // If an xterm bump renames or hides this, the counts above would silently read 0 and the
    // suite would "pass" while the crash regressed. Fail here instead, pointing at the cause.
    const t = makeTerm()
    const core = (t as unknown as XtermCore)._core
    expect(typeof core?.optionsService?.onOptionChange).toBe('function')
    // And the trap that a previous version of this guard fell into: these are NOT the same
    // object, so `term.options` cannot be used to suppress or to observe the option.
    expect(t.options as unknown).not.toBe(core.options)
  })
})
