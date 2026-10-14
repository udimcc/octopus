/**
 * Typed mirror of the design tokens defined in `globals.css` (`:root`). Every
 * value here is a `var(--...)` string — the literal hex/px live ONLY in
 * `globals.css`, so there is one source of truth. Inline `style={}` objects across
 * the renderer reference these (e.g. `background: color.bgSidebar`), the global
 * sheet references the same vars, and a future light theme is just a second `:root`
 * block with no code changes here.
 *
 * The legacy `color` keys (terminalBg, border, activeRow, …) are kept as aliases so
 * existing imports keep working; new code should prefer the semantic names.
 */

export const color = {
  /* Surfaces */
  bgApp: 'var(--bg-app)',
  bgSidebar: 'var(--bg-sidebar)',
  bgSurface: 'var(--bg-surface)',
  bgSurfaceRaised: 'var(--bg-surface-raised)',
  bgSelected: 'var(--bg-selected)',
  bgHover: 'var(--bg-hover)',
  bgInput: 'var(--bg-input)',

  /* Borders */
  border: 'var(--border)',
  borderStrong: 'var(--border-strong)',
  borderSubtle: 'var(--border-subtle)',

  /* Text */
  text: 'var(--text-primary)',
  textSecondary: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  textInverse: 'var(--text-inverse)',

  /* Accent */
  accent: 'var(--accent)',
  accentHover: 'var(--accent-hover)',
  accentActive: 'var(--accent-active)',
  accentSubtle: 'var(--accent-subtle)',
  onAccent: 'var(--on-accent)',
  statusWorking: 'var(--status-working)',
  statusThinking: 'var(--status-thinking)',

  /* Semantic */
  errorBg: 'var(--error-bg)',
  errorText: 'var(--error-fg)',
  errorBorder: 'var(--error-border)',
  infoBg: 'var(--info-bg)',
  infoText: 'var(--info-fg)',
  infoBorder: 'var(--info-border)',
  successText: 'var(--success-fg)',

  overlay: 'var(--overlay)',

  /* Legacy aliases (kept so older imports don't break) */
  terminalBg: 'var(--bg-terminal)',
  borderLight: 'var(--border-subtle)',
  activeRow: 'var(--bg-selected)',
  hoverRow: 'var(--bg-hover)',
  panelBg: 'var(--bg-sidebar)',
  modalBg: 'var(--bg-surface)'
} as const

/**
 * Fixed 6-color palette for split-pane groups (DESIGN §5.7, split-groups design).
 * `GroupDTO.colorIndex` indexes this array (mirrors the domain's
 * `GROUP_COLOR_PALETTE_SIZE`, which the renderer cannot import); assigned once at
 * group creation and stable until the group dissolves. Chosen to read clearly
 * against the dark theme's surfaces and to stay visually distinct from the
 * status-icon colors (`color.accent` teal, `color.statusWorking` blue (Issue
 * "In progress"), `color.errorText` salmon, `color.muted` gray) so the group line is never
 * mistaken for a status cue. Exception: amber is close in hue to the
 * `color.statusThinking` yellow Working spinner, but a rotating arc is not
 * confusable with a static group line.
 */
export const GROUP_COLOR_PALETTE = [
  '#f97316' /* orange */,
  '#eab308' /* amber */,
  '#84cc16' /* lime */,
  '#8b5cf6' /* violet */,
  '#d946ef' /* fuchsia */,
  '#f472b6' /* pink */
] as const

export const space = {
  x1: 'var(--space-1)',
  x2: 'var(--space-2)',
  x3: 'var(--space-3)',
  x4: 'var(--space-4)',
  x5: 'var(--space-5)',
  x6: 'var(--space-6)',
  x8: 'var(--space-8)'
} as const

export const radius = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  pill: 'var(--radius-pill)'
} as const

export const shadow = {
  sm: 'var(--shadow-sm)',
  md: 'var(--shadow-md)',
  lg: 'var(--shadow-lg)'
} as const

export const font = {
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)'
} as const

export const fontSize = {
  sm: 'var(--font-size-sm)',
  base: 'var(--font-size-base)',
  lg: 'var(--font-size-lg)',
  title: 'var(--font-size-title)'
} as const

/**
 * A full-viewport centered modal backdrop (shared by the modals/dialogs). A plain
 * translucent dim, no `backdrop-filter`: on the GPU-less VDI (SwiftShader) a backdrop
 * blur is re-rendered in software over the whole window on every frame that changes
 * inside or beneath the modal (a tab switch, a button transition, a spinning status
 * icon behind it), which made the New-Task modal visibly lag.
 */
export const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: color.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100
}

/** The elevated modal card. Callers spread this and add width/gap. */
export const modalCardStyle: React.CSSProperties = {
  background: color.bgSurface,
  color: color.text,
  border: `1px solid ${color.border}`,
  borderRadius: 'var(--radius-lg)',
  padding: 20,
  maxWidth: '90vw',
  boxShadow: shadow.lg,
  display: 'flex',
  flexDirection: 'column',
  gap: 12
}

/**
 * The xterm.js terminal palette. xterm does NOT resolve CSS custom properties for
 * its WebGL/Canvas GPU palette, so — unlike everything else — these are concrete
 * hex values. Keep them in sync with the accent/surface vars in `globals.css`.
 */
export const terminalTheme = {
  background: '#0e1116',
  foreground: '#e6e9ef',
  cursor: '#2dd4bf',
  cursorAccent: '#0e1116',
  selectionBackground: 'rgba(45,212,191,0.30)',
  black: '#161b22',
  brightBlack: '#4b5563',
  red: '#ff6b66',
  brightRed: '#ff9a92',
  green: '#5ad48a',
  brightGreen: '#7ee0a0',
  yellow: '#e3c766',
  brightYellow: '#f2d98a',
  blue: '#4f8cff',
  brightBlue: '#6da0ff',
  magenta: '#c88bff',
  brightMagenta: '#d8a8ff',
  cyan: '#2dd4bf',
  brightCyan: '#5eead4',
  white: '#c8ced8',
  brightWhite: '#f5f7fa'
} as const
