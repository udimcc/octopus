/**
 * Cursor-blink option guard (DESIGN §5.3).
 *
 * WHY THIS EXISTS — it fixes a renderer-process death, not a cosmetic nit.
 *
 * xterm treats DECSET/DECRST **12** (`ESC[?12h` / `ESC[?12l`, "cursor blink") as a write
 * to a terminal *option*: `InputHandler.setModePrivate`/`resetModePrivate` case 12 do
 * `optionsService.options.cursorBlink = true/false`. An option write is expensive by
 * design — `DomRenderer` subscribes to `onOptionChange` UNFILTERED, and its handler
 * synchronously does `_updateDimensions()` (5 inline style props on every row element →
 * a forced layout) + `_injectCss(themeColors)` + `_setDefaultSpacing()` (one `WidthCache`
 * DOM measurement, i.e. another forced layout). `_injectCss` is the dominant cost: it
 * rebuilds the terminal's whole theme stylesheet (measured at **54 762 bytes** for a
 * 120×40 terminal) and assigns it to `<style>.textContent`, i.e. a full stylesheet
 * **reparse into fresh CSSRule objects** in Blink's heap. `OptionsService` dedupes equal
 * writes, so a repeated `?12h` is free; an *alternating* stream is not.
 *
 * The measured producer on this host is **Emacs**, via terminfo `cnorm` then `cvvis` —
 * two `cursorBlink` writes per repaint. From the app's own captured history: 4212 ×
 * `ESC[?12l` and 4209 × the COMBINED `ESC[?12;25h`, alternating. (Claude Code is not the
 * emitter: mode 12 is absent from its DEC-mode enum — it hides the real cursor with
 * `ESC[?25l` and paints its own inverse-video caret.) Every mounted pane pays it (the
 * §5.3 keep-alive keeps ~all sessions mounted, and this host runs the DOM renderer
 * because its GL is software — see `gpu-capability.ts`), and a daemon re-attach replays
 * each session's whole ring buffer at once, so days of accumulated toggles land in one
 * synchronous burst × every session. Measured symptom with 47 restored sessions: the main
 * window's renderer RSS climbed 96 MB → 1.9 GB in ~12 s and Chromium aborted it
 * (`render-process-gone { reason: 'crashed', exitCode: 133 }` = SIGTRAP), leaving a
 * permanently white window. There was NO JavaScript error and the V8 heap sat at 240 MB of
 * its 4096 MB limit — the memory was all Blink-side CSSOM/layout churn, and a CPU profile
 * put ~65% of self time in `DomRenderer._handleOptionsChanged` reached from
 * `setModePrivate`/`resetModePrivate` case 12.
 *
 * THE FIX: a parser handler that swallows the sequence before xterm's own handler sees it,
 * but ONLY when mode 12 is the sole parameter, so combined sequences keep working. That is
 * enough because it breaks the *alternation*: the surviving `ESC[?12;25h` raises the option
 * once and `OptionsService` dedupes every repeat. Measured on the verbatim captured Emacs
 * frame, 100 repaints: **199 option events → 1**.
 *
 * RESIDUALS, deliberately accepted (all measured, `cursor-blink-guard.test.ts`):
 *  - The option settles at `true` (from that one surviving combined raise), so the cursor
 *    blinks — stably, and `DomRenderer` scopes the animation to `.xterm-rows.xterm-focus`,
 *    so at most the FOCUSED pane animates, never all 47. This is strictly calmer than
 *    today's per-frame flicker between blinking and not.
 *  - A producer alternating the *combined* form (`?12;25h`/`?12;25l`) would still cost one
 *    event per frame. Nothing in captured history does (`?25;12l` → 0 occurrences).
 *  - DECSCUSR (`ESC[Ps SP q`) is xterm's third and last `cursorBlink` write site and is not
 *    guarded: swallowing it would mean reimplementing xterm's param→`cursorStyle` table
 *    (drift risk) for zero measured benefit — captured history contains 0 DECSCUSR bytes.
 *
 * NOT the fix, for the record: pinning `term.options.cursorBlink`. `Terminal` exposes a
 * SEPARATE `_publicOptions` object (`term.options !== term._core.options`, verified), while
 * `InputHandler` writes `optionsService.options` — so a pin there only makes the public
 * getter lie while every write, `onOptionChange` fire and render cascade still happens
 * (measured: 100 combined flips → 100 events, with the pin installed). Pinning the real
 * object works but means reaching through `_core`, an undeclared minifier-renamed field.
 */

import type { Terminal } from '@xterm/xterm'

/**
 * True when a DECSET/DECRST parameter list is EXACTLY mode 12 and nothing else.
 *
 * Used as the parser handler itself: returning `true` means "handled", so xterm's own
 * `{ prefix: '?', final: 'h'|'l' }` handler is skipped; returning `false` falls through to
 * it untouched. (Handlers run in reverse registration order and stop at the first `true`;
 * xterm's internal ones register first, so ours is consulted first —
 * `EscapeSequenceParser.ts:673-690`.) The fall-through is why this is deliberately strict:
 * `ESC[?12;1000h` (blink + mouse tracking) must still reach xterm so mouse tracking is set.
 * Sub-parameters arrive as a nested array (`ESC[?12:1h` → `[12, [1]]`), which fails the
 * length check and is passed through, as it should be.
 */
export function isCursorBlinkOnlyDecMode(params: readonly (number | number[])[]): boolean {
  return params.length === 1 && params[0] === 12
}

/**
 * Install the guard on a freshly constructed `Terminal`. Call before `term.open()` and
 * before any `write()` — a re-attach replay starts the instant the pty sink registers.
 *
 * Nothing to dispose: `term.dispose()` drops the parser's whole handler table
 * (`EscapeSequenceParser.ts:286-290`), and the guard captures no state. `parser` is public,
 * non-proposed API (`Terminal.ts` `get parser()` has no `_checkProposedApi()` call), and the
 * handlers are per-instance, so an unguarded terminal elsewhere is unaffected.
 */
export function installCursorBlinkGuard(term: Terminal): void {
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, isCursorBlinkOnlyDecMode)
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, isCursorBlinkOnlyDecMode)
}
