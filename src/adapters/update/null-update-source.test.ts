import { describe, it, expect } from 'vitest'
import type { UpdateSource } from '../../ports/update-source'
import { NullUpdateSource } from './null-update-source'

describe('NullUpdateSource (macOS: no self-update)', () => {
  it('lists no candidates for any dir, so the checker reports up to date', async () => {
    const src: UpdateSource = new NullUpdateSource()
    await expect(src.listCandidates('/mnt/scratch/octopus', 1000)).resolves.toEqual({
      kind: 'ok',
      candidates: []
    })
  })

  it('refuses to stage a release and cleans up as a no-op', async () => {
    const src: UpdateSource = new NullUpdateSource()
    await expect(src.stageToTemp('/mnt/scratch/octopus/octopus-9.9.9')).rejects.toThrow(
      /not supported/
    )
    await expect(src.cleanup('/tmp/x')).resolves.toBeUndefined()
  })
})
