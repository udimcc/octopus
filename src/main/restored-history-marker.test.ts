/**
 * The end-of-history marker is declared twice: by the application layer, which writes
 * it, and in `shared` for the renderer, which reads it (neither may import the other's
 * copy). Main may import both, so it pins them equal.
 */
import { expect, it } from 'vitest'
import { RESTORED_HISTORY_END as written } from '../application/use-cases/sanitize-restored-history'
import { RESTORED_HISTORY_END as read } from '../shared/restored-history'

it('application and renderer agree on the restored-history marker', () => {
  expect(written).toBe(read)
})
