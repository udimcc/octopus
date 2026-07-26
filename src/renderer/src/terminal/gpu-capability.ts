/**
 * GPU-capability probe for the renderer tier (DESIGN §5.3).
 *
 * xterm's accelerated renderers (`WebglAddon`, `CanvasAddon`) are a TRAP on a
 * software-GL display: WebGL "succeeds" on a software rasterizer (SwiftShader /
 * llvmpipe) instead of throwing, so the tier logic never falls back — yet every
 * frame then pays a synchronous `ReadPixels` stall to copy the rendered pixels
 * out of the software buffer for compositing (observed on a VMware Horizon VDI:
 * "GL Driver Message … GPU stall due to ReadPixels", with emacs/Spacemacs's
 * dense full-frame repaints making it multi-second). xterm's DOM renderer (plain
 * spans + CSS) has no canvas and no readback, so the X server / remoting layer
 * blits text cheaply — the fastest path when there is no real GPU.
 *
 * So we detect the underlying renderer once and, when it is software (or WebGL is
 * unavailable), skip BOTH accelerated tiers and let xterm use its built-in DOM
 * renderer. On a real GPU this returns `'hardware'` and the WebGL/Canvas tiers
 * are used as before.
 *
 * Split pure/effectful (like `adapters/env/paths.ts`): {@link detectGpuTier} is a
 * pure function of the GL context so it is unit-testable without a real WebGL
 * stack; {@link probeGpuTier} is the memoized effectful wrapper that creates the
 * throwaway context.
 */

export type GpuTier = 'hardware' | 'software' | 'none'

/**
 * Substrings (matched case-insensitively) that identify a software rasterizer in
 * the `UNMASKED_RENDERER_WEBGL` string. `subzero` is SwiftShader's LLVM backend
 * ("SwiftShader Device (Subzero)"); `basic` covers Windows' basic-render driver.
 */
const SOFTWARE_RENDERER_PATTERNS = [
  'swiftshader',
  'llvmpipe',
  'softpipe',
  'software',
  'subzero',
  'basic render'
] as const

/**
 * Classify a GL context by its unmasked renderer string. `null` (WebGL could not
 * be created at all) → `'none'`; a renderer we can't read → assume `'software'`
 * (safer: an unknown/blocklisted GPU behaves like the software path more often
 * than not, and the DOM renderer is the safe default). A recognizable hardware
 * renderer → `'hardware'`.
 */
export function detectGpuTier(gl: WebGL2RenderingContext | null): GpuTier {
  if (!gl) {
    return 'none'
  }
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  if (!ext) {
    // No debug-renderer extension: can't tell. Treat as software so we don't
    // gamble the ReadPixels stall on a display we can't identify.
    return 'software'
  }
  const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '').toLowerCase()
  if (renderer === '') {
    return 'software'
  }
  return SOFTWARE_RENDERER_PATTERNS.some((p) => renderer.includes(p)) ? 'software' : 'hardware'
}

let cached: GpuTier | undefined

/**
 * Probe the display's GPU tier once (memoized). Creates a throwaway `<canvas>`,
 * asks for a WebGL2 context, classifies it, and releases the context. Any failure
 * to obtain a context → `'none'`. Memoized because the answer is fixed for the
 * process lifetime and every pane asks.
 */
export function probeGpuTier(): GpuTier {
  if (cached !== undefined) {
    return cached
  }
  let tier: GpuTier = 'none'
  try {
    const canvas = document.createElement('canvas')
    // A plain context (no `failIfMajorPerformanceCaveat`): on this host it lands on
    // SwiftShader, which we then classify as software below. Creating ANY WebGL
    // context on a GPU-less display makes Chromium's GPU process log an ERROR — the
    // "deprecated software-WebGL fallback" warning here, or a `kFatalFailure` if we
    // fail-on-caveat. The main process opts into the software path once via the
    // `enable-unsafe-swiftshader` switch (see `src/main/index.ts`) so this one-time
    // probe context is created silently. We drop it immediately after reading.
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null
    tier = detectGpuTier(gl)
    // Proactively drop the context so the probe leaves nothing behind.
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    tier = 'none'
  }
  cached = tier
  return tier
}

/** Test-only: reset the memoized tier so a test can re-probe. */
export function resetGpuTierCache(): void {
  cached = undefined
}
