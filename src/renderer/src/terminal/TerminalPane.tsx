/**
 * The xterm host for one terminal session (DESIGN §5.3, §6.1). This is the most
 * lifecycle-sensitive component in the app, so the rules are strict:
 *
 *  - The `Terminal` is created EXACTLY ONCE, in a mount effect with an empty dep
 *    array, and lives in a ref. It is never recreated on re-render — recreating it
 *    would wipe scrollback and drop the PTY sink registration.
 *  - Output arrives via the `pty-router` bypass, not through React state: on mount
 *    we `registerTerminalSink(id, d => term.write(d))`. Keystrokes go the other way,
 *    `term.onData(d => pty.write(...))`.
 *  - The terminal is disposed (and its sink unregistered) only when the pane
 *    unmounts — which in V1 happens on session close. Task switching keeps every
 *    pane mounted (just hidden), so buffers survive (§5.3).
 *
 * `active` drives the on-show refit: when a hidden pane becomes visible its
 * container finally has real dimensions, so we fit → resize → refresh to avoid the
 * "reflow pop" a stale grid would show. Conversely, while hidden the pane collapses
 * to 0×0 and `fitAndResize` must NOT fit — a 0×0 fit shrinks xterm to its 2×1 floor
 * and reflows the scrollback, which leaves a NORMAL-buffer TUI (Claude Code) scrolled
 * to the top on the way back; `fitAndResize` guards on the host's layout box.
 *
 * `active` ALSO drives the renderer tier (§5.3): with every pane kept mounted, we
 * can't hold a live WebGL context per terminal (browsers cap ~16). So a pane leases
 * a WebGL slot from `webglBudget` when it becomes visible and releases it when
 * hidden; a hidden pane (or one that can't get a lease) renders with `CanvasAddon`
 * instead — still accelerated, and it holds no WebGL context. If even Canvas can't
 * be constructed we dispose nothing extra and xterm's built-in DOM renderer stays
 * as the last-resort fallback.
 *
 * BUT the accelerated tiers are skipped entirely on a software-GL display
 * (SwiftShader/llvmpipe, e.g. a VMware VDI with no GPU): there WebGL/Canvas
 * "succeed" but stall on a per-frame `ReadPixels` pixel readback, so the DOM
 * renderer (no canvas, no readback) is actually the fastest path. `probeGpuTier`
 * detects this once and `applyRendererTier` then leaves xterm on its DOM renderer.
 *
 * On that DOM-renderer path an xterm *option* write is expensive — it rebuilds and
 * reparses the terminal's entire theme stylesheet — and keep-alive means every session
 * pays it. A TUI that flips an option per frame therefore scales with the session count,
 * and one that does (Emacs, whose `cnorm`/`cvvis` repaint toggles cursor blink twice per
 * frame) killed the renderer process outright. `installCursorBlinkGuard` closes that route
 * (`cursor-blink-guard.ts`, §5.3).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store/store'
import { matchesChord } from '../keybindings/chords'
import { registerTerminalSink, unregisterTerminalSink } from '../pty/pty-router'
import { registerSearchOpener, unregisterSearchOpener } from './terminal-search'
import { installCursorBlinkGuard } from './cursor-blink-guard'
import { webglBudget } from './webgl-budget'
import { probeGpuTier } from './gpu-capability'
import { color, radius, shadow, terminalTheme } from '../style/tokens'

export interface TerminalPaneProps {
  readonly sessionId: string
  /** Whether this pane is the visible one for its (active) task. */
  readonly active: boolean
}

const SCROLLBACK = 10000
const RESIZE_DEBOUNCE_MS = 50

type RendererKind = 'webgl' | 'canvas'
/** A disposable object — both addon kinds expose `dispose()`. */
interface DisposableAddon {
  dispose(): void
}
interface LoadedRenderer {
  addon: DisposableAddon
  kind: RendererKind
}

/**
 * Fit to the container and tell the backend the new grid size. Best-effort.
 *
 * No-op while the host has no layout box (`offsetWidth`/`offsetHeight` 0). A hidden
 * task collapses its pane to 0×0 (`TaskView` sets `width/height:0` on the inactive
 * task), and `fit()` does NOT throw there — the FitAddon reads the 0-sized parent and
 * proposes the 2×1 floor. Fitting then would shrink xterm to 2×1 and destructively
 * reflow the NORMAL-buffer scrollback (e.g. Claude Code's Ink TUI). `visibility:hidden`
 * alone keeps a real box, so the non-active session tab of the *active* task (only
 * hidden, not 0×0) still fits.
 */
function fitAndResize(sessionId: string, term: Terminal, fit: FitAddon, host: HTMLElement): void {
  if (host.offsetWidth === 0 || host.offsetHeight === 0) return
  try {
    fit.fit()
  } catch {
    // Host detached mid-teardown — nothing to fit.
    return
  }
  window.octopusAPI.pty.resize({ sessionId, cols: term.cols, rows: term.rows })
}

/** Load `CanvasAddon`; on failure leave the DOM renderer (no addon held). */
function loadCanvas(term: Terminal, ref: React.MutableRefObject<LoadedRenderer | null>): void {
  try {
    const canvas = new CanvasAddon()
    term.loadAddon(canvas)
    ref.current = { addon: canvas, kind: 'canvas' }
  } catch {
    ref.current = null // DOM renderer stays as the last resort
  }
}

/**
 * Bring the pane's renderer to the tier `active` warrants: WebGL for the visible
 * pane (if a lease is free), Canvas otherwise. Swaps only when the tier actually
 * changes, so a re-render with no visibility change is a no-op.
 *
 * On a software-GL display both accelerated tiers are skipped (they'd stall on
 * per-frame `ReadPixels`); we hold no lease and leave xterm on its DOM renderer.
 */
function applyRendererTier(
  sessionId: string,
  term: Terminal,
  ref: React.MutableRefObject<LoadedRenderer | null>,
  active: boolean
): void {
  // No real GPU (SwiftShader/llvmpipe/no-WebGL): the DOM renderer is fastest here.
  // Drop any accelerated addon we somehow hold, release the lease, and stop.
  if (probeGpuTier() !== 'hardware') {
    ref.current?.addon.dispose()
    ref.current = null
    webglBudget.release(sessionId)
    return
  }

  const wantWebgl = active && webglBudget.acquire(sessionId)
  const current = ref.current

  if (wantWebgl) {
    if (current?.kind === 'webgl') return
    current?.addon.dispose()
    ref.current = null
    try {
      const webgl = new WebglAddon()
      // A lost context (GPU reset, tab backgrounded) → drop WebGL and the lease so
      // some other active pane can reclaim it; Canvas takes over on the next tier pass.
      webgl.onContextLoss(() => {
        webgl.dispose()
        if (ref.current?.addon === webgl) ref.current = null
        webglBudget.release(sessionId)
      })
      term.loadAddon(webgl)
      ref.current = { addon: webgl, kind: 'webgl' }
    } catch {
      // WebGL unavailable despite the lease — give it back and fall to Canvas.
      webglBudget.release(sessionId)
      loadCanvas(term, ref)
    }
    return
  }

  // Not the WebGL tier: return any held lease and ensure we're on Canvas/DOM.
  webglBudget.release(sessionId)
  if (current?.kind === 'canvas') return
  current?.addon.dispose()
  ref.current = null
  loadCanvas(term, ref)
}

export function TerminalPane({ sessionId, active }: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const rendererRef = useRef<LoadedRenderer | null>(null)
  // Scroll position captured the instant this pane goes inactive, so the on-show path can
  // restore it after the browser fires a spurious scrollTop=0 on the re-shown 0×0 viewport
  // (the top-scroll bug — see the on-show effect).
  const scrollIntentRef = useRef<{ atBottom: boolean; viewportY: number }>({
    atBottom: true,
    viewportY: 0
  })
  const rafRef = useRef<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Right-click copy/paste menu: viewport-space anchor while open, null when closed.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // Create + mount the terminal exactly once. No deps → never re-runs (§5.3).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      scrollback: SCROLLBACK,
      fontFamily: 'monospace',
      allowProposedApi: true, // required by the Unicode11 addon
      theme: terminalTheme
    })
    // BEFORE anything can write to this terminal: stop DECSET/DECRST 12 (cursor blink)
    // from becoming an xterm *option* write. Every option change rebuilds and reparses
    // this terminal's whole theme stylesheet, and Emacs toggles blink twice per repaint —
    // across all the keep-alive panes that killed the renderer process outright
    // (see `cursor-blink-guard.ts` for the measurement, §5.3).
    installCursorBlinkGuard(term)
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new SerializeAddon())
    term.loadAddon(new WebLinksAddon())
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(host)

    // Chords owned by the global shortcut layer (§5.4) — the eight free-form
    // configurable chords — must NOT reach the PTY. The blanket Ctrl+Shift drop is a
    // safety net covering the Ctrl+Shift defaults; the explicit list also catches a
    // rebind to any other modifier (e.g. `Alt+/`). Returning false drops the key
    // before xterm turns it into `onData` output; the window listener's preventDefault
    // alone is unreliable (xterm's own textarea handler runs first). Settings live via
    // `getState()` so a rebind takes effect without re-attaching. This mirrors
    // `useKeyboardShortcuts` so the layers agree.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const {
        copyKey,
        pasteKey,
        sessionNextKey,
        sessionPrevKey,
        taskNextKey,
        taskPrevKey,
        newSessionKey,
        newTaskKey,
        closeSessionKey,
        searchKey
      } = useStore.getState().settings
      // Copy/paste act on THIS terminal's selection/buffer, so they're handled here
      // (with the live `term`) rather than in the global shortcut hook. Checked before
      // the blanket Ctrl+Shift drop so a rebind to any other modifier still works.
      // `preventDefault()` is REQUIRED: returning false only tells xterm to skip the
      // key, it does NOT cancel the browser default — without it Ctrl+Shift+V's native
      // `paste` event still fires and xterm's textarea handler pastes a SECOND time
      // (the extra copy arriving bracketed/highlighted). Same guard for copy.
      if (matchesChord(e, copyKey)) {
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) void window.octopusAPI.clipboard.write(sel)
        return false
      }
      if (matchesChord(e, pasteKey)) {
        e.preventDefault()
        void window.octopusAPI.clipboard.read().then((text) => term.paste(text))
        return false
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) return false
      const configurable = [
        sessionNextKey,
        sessionPrevKey,
        taskNextKey,
        taskPrevKey,
        newSessionKey,
        newTaskKey,
        closeSessionKey,
        searchKey
      ]
      if (configurable.some((chord) => matchesChord(e, chord))) return false
      return true
    })

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // Start on the tier the initial `active` warrants (the active effect keeps it
    // in sync thereafter). Keeps WebGL leases off hidden panes at mount.
    applyRendererTier(sessionId, term, rendererRef, active)

    // Backend output → this terminal (the §5.2 bypass, not via the store).
    registerTerminalSink(sessionId, (data) => term.write(data))
    // Ctrl+Shift+F opens this pane's search box (§5.4).
    registerSearchOpener(sessionId, () => {
      setSearchOpen(true)
      // Focus after the input renders.
      setTimeout(() => searchInputRef.current?.focus(), 0)
    })
    // Keystrokes → backend PTY (fire-and-forget, §6.5).
    const dataSub = term.onData((data) => window.octopusAPI.pty.write({ sessionId, data }))

    // Right-click → copy/paste menu (§5.4). Suppressed when the app under the cursor
    // reads the mouse (tmux/vim with mouse on): there right-click belongs to that
    // program, so we let xterm forward it instead of stealing it for our menu.
    const onContextMenu = (e: MouseEvent): void => {
      if (term.modes.mouseTrackingMode !== 'none') return
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY })
    }
    host.addEventListener('contextmenu', onContextMenu)

    fitAndResize(sessionId, term, fit, host)

    // Focus a pane that mounts already-active (a freshly opened session becomes the
    // active tab), so the user can type immediately without clicking in. The on-show
    // `useLayoutEffect` can't do this on the FIRST render: it runs in the commit phase
    // BEFORE this passive mount effect, when `termRef` is still null, so it returns
    // early. It handles focus only for LATER active→visible transitions of an
    // already-mounted pane.
    if (active) term.focus()

    // Refit on container resize, debounced so a drag doesn't spam pty:resize.
    let debounce: ReturnType<typeof setTimeout> | undefined
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => fitAndResize(sessionId, term, fit, host), RESIZE_DEBOUNCE_MS)
      })
      observer.observe(host)
    }

    return () => {
      if (debounce) clearTimeout(debounce)
      observer?.disconnect()
      host.removeEventListener('contextmenu', onContextMenu)
      dataSub.dispose()
      unregisterTerminalSink(sessionId)
      unregisterSearchOpener(sessionId)
      rendererRef.current?.addon.dispose()
      rendererRef.current = null
      webglBudget.release(sessionId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
    // `active` is intentionally NOT a dep: the terminal is created once; the tier is
    // re-synced by the active effect below. `active` is read here only to pick the
    // initial renderer tier at mount.
  }, [sessionId])

  // Capture scroll intent the instant this pane goes inactive. `useLayoutEffect` runs
  // synchronously in the commit phase — BEFORE the browser's render step dispatches the
  // scrollTop=0 event that corrupts xterm's `ydisp` (see the on-show effect) — so
  // `viewportY`/`baseY` are still truthful here. The `active` guard snapshots only the
  // state we're leaving (active→hidden); it never overwrites the saved intent during a
  // show commit. Declared ABOVE the on-show effect so it commits first.
  useLayoutEffect(() => {
    const term = termRef.current
    if (!term || active) return
    const buf = term.buffer.active
    scrollIntentRef.current = {
      atBottom: buf.viewportY >= buf.baseY,
      viewportY: buf.viewportY
    }
  }, [active, sessionId])

  // On becoming visible, the container gains real dimensions: refit and repaint so
  // there's no stale-grid "pop" (§5.3). Also re-sync the renderer tier so the newly
  // visible pane claims WebGL and the newly hidden one gives it back.
  //
  // Restore scroll: a task's pane is hidden via `visibility:hidden; width:0; height:0`
  // (TaskView §5.3), NOT `display:none`. xterm's Viewport listens for DOM `scroll` on
  // `.xterm-viewport` and maps `scrollTop`→`ydisp` in `_handleScroll`; on re-show the
  // 0×0-collapsed element fires a spurious `scrollTop=0`, driving `ydisp`→0 (top). Its
  // only guard is `offsetParent`, which is null only for `display:none`, so our hide
  // slips past it (xterm #4066). We restore the pre-hide position: if we were pinned to
  // the bottom, follow new output (baseY grew while hidden); else return to the exact
  // line so a user reading history isn't yanked. Done synchronously now (commit phase,
  // pre-paint — no top-flash) AND in a rAF: Chromium dispatches the bogus scroll event
  // before rAF callbacks in the same frame, so the rAF re-apply lands after it and wins.
  useLayoutEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host) return
    applyRendererTier(sessionId, term, rendererRef, active)
    if (!active) return
    fitAndResize(sessionId, term, fit, host) // reflow first — this moves baseY
    term.refresh(0, term.rows - 1)
    const restore = (): void => {
      const t = termRef.current
      if (!t) return
      if (scrollIntentRef.current.atBottom) t.scrollToBottom()
      else t.scrollToLine(scrollIntentRef.current.viewportY)
    }
    restore()
    term.focus()

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      restore()
    })

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [active, sessionId])

  const runSearch = (backwards: boolean): void => {
    const search = searchRef.current
    if (!search || query === '') return
    if (backwards) search.findPrevious(query)
    else search.findNext(query)
  }

  // Dismiss the right-click menu on an outside click or Escape. Only mounted while
  // the menu is open, so it costs nothing when closed. `mousedown` (not `click`) so
  // the menu closes before a fresh contextmenu elsewhere reopens it.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Copy the current selection (no-op if empty); paste the clipboard into the PTY.
  // Both close the menu. Read via the port (Electron clipboard), not navigator (§5.5).
  const copySelection = (): void => {
    const sel = termRef.current?.getSelection()
    if (sel) void window.octopusAPI.clipboard.write(sel)
    setMenu(null)
  }
  const pasteClipboard = (): void => {
    const term = termRef.current
    if (term) void window.octopusAPI.clipboard.read().then((text) => term.paste(text))
    setMenu(null)
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {searchOpen ? (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 10,
            display: 'flex',
            gap: 4,
            padding: 6,
            background: color.bgSurfaceRaised,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            boxShadow: shadow.md
          }}
        >
          <input
            ref={searchInputRef}
            aria-label="terminal search"
            value={query}
            placeholder="Find…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') runSearch(e.shiftKey)
              else if (e.key === 'Escape') setSearchOpen(false)
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="find previous"
            onClick={() => runSearch(true)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="find next"
            onClick={() => runSearch(false)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="close search"
            onClick={() => setSearchOpen(false)}
          >
            ✕
          </button>
        </div>
      ) : null}
      <div ref={hostRef} className="terminal-pane" style={{ width: '100%', height: '100%' }} />
      {menu ? (
        <div
          role="menu"
          aria-label="terminal actions"
          // Stop mousedown here so the window-level dismiss listener doesn't close the
          // menu before a button's click lands.
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: menu.y,
            left: menu.x,
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 120,
            padding: 4,
            background: color.bgSurfaceRaised,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            boxShadow: shadow.md
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!termRef.current?.getSelection()}
            onClick={copySelection}
            style={{ width: '100%', textAlign: 'left', padding: '6px 8px', cursor: 'pointer' }}
          >
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={pasteClipboard}
            style={{ width: '100%', textAlign: 'left', padding: '6px 8px', cursor: 'pointer' }}
          >
            Paste
          </button>
        </div>
      ) : null}
    </div>
  )
}
