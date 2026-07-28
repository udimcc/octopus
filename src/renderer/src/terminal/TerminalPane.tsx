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
 * "reflow pop" a stale grid would show.
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
 */

import { useEffect, useRef, useState } from 'react'
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

/** Fit to the container and tell the backend the new grid size. Best-effort. */
function fitAndResize(sessionId: string, term: Terminal, fit: FitAddon): void {
  try {
    fit.fit()
  } catch {
    // Container not laid out yet (e.g. hidden pane, jsdom) — nothing to fit.
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
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

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

    // Chords owned by the global shortcut layer (§5.4) — the fixed Ctrl+Shift set
    // plus the two free-form session-switch chords — must NOT reach the PTY.
    // Returning false drops the key before xterm turns it into `onData` output; the
    // window listener's preventDefault alone is unreliable (xterm's own textarea
    // handler runs first). Settings live via `getState()` so a rebind takes effect
    // without re-attaching. This mirrors `useKeyboardShortcuts` so the layers agree.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) return false
      const { sessionNextKey, sessionPrevKey } = useStore.getState().settings
      if (matchesChord(e, sessionNextKey) || matchesChord(e, sessionPrevKey)) return false
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

    fitAndResize(sessionId, term, fit)

    // Refit on container resize, debounced so a drag doesn't spam pty:resize.
    let debounce: ReturnType<typeof setTimeout> | undefined
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => fitAndResize(sessionId, term, fit), RESIZE_DEBOUNCE_MS)
      })
      observer.observe(host)
    }

    return () => {
      if (debounce) clearTimeout(debounce)
      observer?.disconnect()
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

  // On becoming visible, the container gains real dimensions: refit and repaint so
  // there's no stale-grid "pop" (§5.3). Also re-sync the renderer tier so the newly
  // visible pane claims WebGL and the newly hidden one gives it back.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    applyRendererTier(sessionId, term, rendererRef, active)
    if (!active) return
    fitAndResize(sessionId, term, fit)
    term.refresh(0, term.rows - 1)
    term.focus()
  }, [active, sessionId])

  const runSearch = (backwards: boolean): void => {
    const search = searchRef.current
    if (!search || query === '') return
    if (backwards) search.findPrevious(query)
    else search.findNext(query)
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
    </div>
  )
}
