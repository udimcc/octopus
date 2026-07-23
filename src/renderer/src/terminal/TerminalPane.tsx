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
 */

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { registerTerminalSink, unregisterTerminalSink } from '../pty/pty-router'

export interface TerminalPaneProps {
  readonly sessionId: string
  /** Whether this pane is the visible one for its (active) task. */
  readonly active: boolean
}

const SCROLLBACK = 10000
const RESIZE_DEBOUNCE_MS = 50

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

export function TerminalPane({ sessionId, active }: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // Create + mount the terminal exactly once. No deps → never re-runs (§5.3).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      scrollback: SCROLLBACK,
      fontFamily: 'monospace',
      allowProposedApi: true, // required by the Unicode11 addon
      theme: { background: '#1e1e1e' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new SearchAddon())
    term.loadAddon(new SerializeAddon())
    term.loadAddon(new WebLinksAddon())
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(host)

    // WebGL is an accelerator; if the context can't be created or is lost, dispose
    // it and let xterm fall back to its built-in DOM renderer (§5.3).
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // No WebGL here (headless/jsdom/context-cap) — DOM renderer stays.
    }

    termRef.current = term
    fitRef.current = fit

    // Backend output → this terminal (the §5.2 bypass, not via the store).
    registerTerminalSink(sessionId, (data) => term.write(data))
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
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  // On becoming visible, the container gains real dimensions: refit and repaint so
  // there's no stale-grid "pop" (§5.3).
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    fitAndResize(sessionId, term, fit)
    term.refresh(0, term.rows - 1)
    term.focus()
  }, [active, sessionId])

  return <div ref={hostRef} className="terminal-pane" style={{ width: '100%', height: '100%' }} />
}
