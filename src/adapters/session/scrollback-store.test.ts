import { describe, it, expect } from 'vitest'
import { RingBufferScrollbackStore } from './scrollback-store'
import { asSessionId } from '../../domain/ids'

const s1 = asSessionId('s1')
const s2 = asSessionId('s2')

describe('RingBufferScrollbackStore (§6.6)', () => {
  it('accumulates a session output across appends and returns it via snapshot', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'hello ')
    store.append(s1, 'world')
    expect(store.snapshot(s1)).toBe('hello world')
  })

  it('keeps sessions independent', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'aaa')
    store.append(s2, 'bbb')
    expect(store.snapshot(s1)).toBe('aaa')
    expect(store.snapshot(s2)).toBe('bbb')
  })

  it('returns undefined for a session that was never written', () => {
    const store = new RingBufferScrollbackStore()
    expect(store.snapshot(s1)).toBeUndefined()
  })

  it('ignores empty appends (never creates an empty buffer)', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, '')
    expect(store.snapshot(s1)).toBeUndefined()
    expect([...store.entries()]).toEqual([])
  })

  it('entries yields every non-empty buffer as [id, output]', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'x')
    store.append(s2, 'y')
    expect(new Map(store.entries())).toEqual(
      new Map([
        [s1, 'x'],
        [s2, 'y']
      ])
    )
  })

  it('delete frees one buffer, leaving the others', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'x')
    store.append(s2, 'y')
    store.delete(s1)
    expect(store.snapshot(s1)).toBeUndefined()
    expect(store.snapshot(s2)).toBe('y')
  })

  it('clear drops every buffer', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'x')
    store.append(s2, 'y')
    store.clear()
    expect([...store.entries()]).toEqual([])
  })

  it('honors the byte cap via the underlying RingBuffer (oldest chunks evicted)', () => {
    // 4-byte cap: after three 2-byte writes only the tail survives (the cap keeps
    // at least the most recent chunk; older ones are evicted).
    const store = new RingBufferScrollbackStore(4)
    store.append(s1, 'AA')
    store.append(s1, 'BB')
    store.append(s1, 'CC')
    const snap = store.snapshot(s1)!
    expect(Buffer.byteLength(snap, 'utf8')).toBeLessThanOrEqual(4)
    expect(snap.endsWith('CC')).toBe(true)
    expect(snap).not.toContain('AA')
  })
})
