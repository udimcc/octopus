import { describe, it, expect } from 'vitest'
import { detectGpuTier } from './gpu-capability'

/** A minimal fake GL context whose renderer string the test controls. */
function fakeGl(renderer: string | null, opts: { hasExt?: boolean } = {}): WebGL2RenderingContext {
  const hasExt = opts.hasExt ?? true
  const RENDERER_KEY = 0x9246 // arbitrary sentinel for UNMASKED_RENDERER_WEBGL
  return {
    getExtension: (name: string) =>
      name === 'WEBGL_debug_renderer_info' && hasExt
        ? { UNMASKED_RENDERER_WEBGL: RENDERER_KEY }
        : null,
    getParameter: (p: number) => (p === RENDERER_KEY ? renderer : null)
  } as unknown as WebGL2RenderingContext
}

describe('detectGpuTier (§5.3)', () => {
  it('classifies the observed VMware VDI SwiftShader renderer as software', () => {
    // The exact string reported on the affected VDI.
    const gl = fakeGl(
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
    )
    expect(detectGpuTier(gl)).toBe('software')
  })

  it('classifies llvmpipe as software', () => {
    expect(detectGpuTier(fakeGl('llvmpipe (LLVM 15.0.0, 256 bits)'))).toBe('software')
  })

  it('classifies a real GPU as hardware', () => {
    expect(detectGpuTier(fakeGl('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11)'))).toBe(
      'hardware'
    )
  })

  it('returns none when there is no GL context at all', () => {
    expect(detectGpuTier(null)).toBe('none')
  })

  it('assumes software when the debug-renderer extension is unavailable', () => {
    expect(detectGpuTier(fakeGl('whatever', { hasExt: false }))).toBe('software')
  })

  it('assumes software when the renderer string is empty', () => {
    expect(detectGpuTier(fakeGl(''))).toBe('software')
    expect(detectGpuTier(fakeGl(null))).toBe('software')
  })
})
