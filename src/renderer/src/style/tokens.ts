/**
 * Shared inline-style constants (DESIGN §5 — the renderer styles with `style={}`
 * objects, CSP-safe, no CSS pipeline). Centralizing the handful of colors and
 * repeated layout snippets here keeps the extracted M6 components consistent
 * without duplicating literals across a dozen files. Values mirror the ones the
 * M5 slice used inline (`#1e1e1e` terminal bg, `#e0e0ff` active row, …).
 */

export const color = {
  terminalBg: '#1e1e1e',
  border: '#ccc',
  borderLight: '#e5e5e5',
  activeRow: '#e0e0ff',
  hoverRow: '#f0f0f5',
  muted: '#888',
  text: '#222',
  panelBg: '#fafafa',
  modalBg: '#fff',
  overlay: 'rgba(0,0,0,0.35)',
  errorBg: '#fdecea',
  errorText: '#a12622',
  errorBorder: '#f5c6c3',
  infoBg: '#eef4fd',
  infoText: '#1c3f66',
  infoBorder: '#c3d8f5'
} as const

/** A full-viewport centered modal backdrop (shared by the modals/dialogs). */
export const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: color.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100
}

/** The white modal card. Callers spread this and add width/gap. */
export const modalCardStyle: React.CSSProperties = {
  background: color.modalBg,
  borderRadius: 6,
  padding: 20,
  maxWidth: '90vw',
  boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12
}
