/**
 * Sticky terminal-mode tracking for re-attach (DESIGN §6.2).
 *
 * ## Why this exists
 * Replaying a session's ring buffer restores what the OLD terminal *showed*; it does
 * not restore what the old terminal *was*. A full-screen program configures its
 * terminal ONCE, at startup — alternate screen (`smcup`), application cursor keys
 * (`smkx`), bracketed paste, mouse reporting — and never repeats itself. For a session
 * that has been running for days those bytes were evicted from the ring buffer long
 * ago, so a re-attached xterm comes up in the DEFAULT modes while the program assumes
 * the ones it set. The visible symptoms: arrow keys stop working in `emacsclient -nw`
 * (the program decodes `ESC O A`, the fresh terminal sends `ESC [ A`), paste is no
 * longer bracketed, the mouse is dead, and output lands in the normal buffer with the
 * scrollback interleaved.
 *
 * So the daemon watches the output stream for DEC private mode changes for the whole
 * life of the PTY — the tracker is NOT bounded like the ring buffer, it is a handful of
 * booleans — and replays the surviving ones on attach.
 *
 * ## Scope and honest limits
 * - Only `CSI ? Pm ; … h|l` (DECSET/DECRST) and the two keypad controls `ESC =` /
 *   `ESC >` are tracked, and only the modes in {@link STICKY_MODES}: the ones that
 *   change how the terminal *interprets input* or *where output goes*, which are
 *   exactly the ones a fresh terminal gets wrong. Transient per-frame state (cursor
 *   position, SGR colors, scroll region) is deliberately NOT tracked — the program
 *   repaints that itself once it gets the SIGWINCH the re-attach forces.
 * - XTSAVE/XTRESTORE (`CSI ? Pm s` / `CSI ? Pm r`) is not modelled; a program that
 *   saves and restores modes instead of setting them explicitly is invisible here. In
 *   practice programs use plain DECSET/DECRST at startup.
 * - Only modes actually SEEN are restored, and only when they differ from the
 *   terminal's default — so a session that never touched a mode emits nothing.
 */

/** A DEC private mode we re-assert on attach, with the value a fresh xterm starts at. */
interface StickyMode {
  /** DEC private mode number, as in `CSI ? <code> h`. */
  readonly code: number
  /** What a freshly opened terminal has this mode set to. */
  readonly defaultOn: boolean
  readonly what: string
}

/**
 * Ordered deliberately: the screen switch (1049/1047/47) comes LAST so the restore
 * prologue lands in the normal buffer along with the replayed scrollback, and only
 * then swaps to a clean alternate screen for the program to repaint into. (Restoring
 * it first would put the replayed history in the alternate buffer, where leaving the
 * program would wipe it.)
 */
export const STICKY_MODES: readonly StickyMode[] = [
  { code: 1, defaultOn: false, what: 'DECCKM application cursor keys' },
  { code: 7, defaultOn: true, what: 'DECAWM autowrap' },
  { code: 25, defaultOn: true, what: 'DECTCEM cursor visible' },
  { code: 1000, defaultOn: false, what: 'X11 mouse: click tracking' },
  { code: 1002, defaultOn: false, what: 'X11 mouse: button-event tracking' },
  { code: 1003, defaultOn: false, what: 'X11 mouse: any-event tracking' },
  { code: 1004, defaultOn: false, what: 'focus in/out reporting' },
  { code: 1005, defaultOn: false, what: 'UTF-8 mouse encoding' },
  { code: 1006, defaultOn: false, what: 'SGR mouse encoding' },
  { code: 1015, defaultOn: false, what: 'urxvt mouse encoding' },
  { code: 2004, defaultOn: false, what: 'bracketed paste' },
  { code: 47, defaultOn: false, what: 'alternate screen (legacy)' },
  { code: 1047, defaultOn: false, what: 'alternate screen (legacy, clear on exit)' },
  { code: 1049, defaultOn: false, what: 'alternate screen + saved cursor' }
]

const STICKY_CODES = new Set(STICKY_MODES.map((m) => m.code))

// Matching the ESC (\x1b) control byte IS this module's job — the no-control-regex lint
// is a false positive here (same as `application/use-cases/sanitize-restored-history.ts`).
/* eslint-disable no-control-regex */

/** `CSI ? <params> h|l` — params are `;`-separated, e.g. `\x1b[?1000;1002;1006h`. */
const DEC_PRIVATE_MODE = /\x1b\[\?([0-9;]{1,64})([hl])/g

/**
 * Longest sequence we might have to hold across a chunk boundary: `\x1b[?` + up to 64
 * param chars + the final byte. A carry longer than this cannot become a match.
 */
const MAX_CARRY = 72

export class TerminalModeTracker {
  /** Mode code → current value; absent means "never seen, still at its default". */
  private readonly modes = new Map<number, boolean>()
  /** Application keypad (DECKPAM `ESC =` / DECKPNM `ESC >`); undefined = never set. */
  private keypadApplication: boolean | undefined
  /** Trailing bytes of the previous chunk that may be the start of a sequence. */
  private carry = ''

  /**
   * Feed program output. Safe to call with arbitrary chunking: an escape sequence split
   * across two chunks is still recognized.
   */
  observe(chunk: string): void {
    if (chunk.length === 0) {
      return
    }
    const text = this.carry.length > 0 ? this.carry + chunk : chunk
    // Cheap bail-out: the overwhelming majority of terminal output carries none of
    // this, and `observe` runs on every batched chunk of every session.
    if (text.includes('\x1b')) {
      this.scan(text)
    }
    this.carry = trailingPartial(text)
  }

  private scan(text: string): void {
    DEC_PRIVATE_MODE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = DEC_PRIVATE_MODE.exec(text)) !== null) {
      const on = match[2] === 'h'
      for (const param of match[1].split(';')) {
        if (param === '') {
          continue
        }
        const code = Number(param)
        if (STICKY_CODES.has(code)) {
          this.modes.set(code, on)
        }
      }
    }
    // DECKPAM/DECKPNM. Scanned separately: two bytes, no parameters.
    for (
      let i = text.indexOf('\x1b');
      i !== -1 && i < text.length - 1;
      i = text.indexOf('\x1b', i + 1)
    ) {
      const next = text[i + 1]
      if (next === '=') {
        this.keypadApplication = true
      } else if (next === '>') {
        this.keypadApplication = false
      }
    }
  }

  /**
   * The sequence that puts a freshly opened terminal back into the modes this session's
   * program set, or `''` if it never set any that differ from the defaults. Emit it
   * AFTER the replayed scrollback (see {@link STICKY_MODES} on ordering).
   */
  restoreSequence(): string {
    let out = ''
    if (this.keypadApplication !== undefined) {
      out += this.keypadApplication ? '\x1b=' : '\x1b>'
    }
    for (const mode of STICKY_MODES) {
      const current = this.modes.get(mode.code)
      if (current === undefined || current === mode.defaultOn) {
        continue
      }
      out += `\x1b[?${mode.code}${current ? 'h' : 'l'}`
    }
    return out
  }

  /** Whether the program is currently on the alternate screen (for tests/diagnostics). */
  get onAlternateScreen(): boolean {
    return (
      (this.modes.get(1049) ?? false) ||
      (this.modes.get(1047) ?? false) ||
      (this.modes.get(47) ?? false)
    )
  }
}

/**
 * The tail of `text` that could still be the prefix of a mode sequence — everything from
 * the last `ESC` that has no final byte after it. Bounded so a stream of bare `ESC`s
 * can't grow the carry.
 */
function trailingPartial(text: string): string {
  const start = text.lastIndexOf('\x1b')
  if (start === -1) {
    return ''
  }
  const tail = text.slice(start)
  if (tail.length > MAX_CARRY) {
    return ''
  }
  // A complete sequence has already been consumed by the scan; only keep a tail that is
  // still a plausible prefix of one we care about.
  return /^\x1b(\[\??[0-9;]*)?$/.test(tail) ? tail : ''
}
/* eslint-enable no-control-regex */
