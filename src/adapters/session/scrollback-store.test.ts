import { describe, it, expect } from 'vitest'
import { RingBufferScrollbackStore, SIZE_MARKER_INTERVAL } from './scrollback-store'
import { historySizeMarker as size } from '../../shared/restored-history'
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
    expect([...store.dirtyEntries()]).toEqual([])
  })

  it('dirtyEntries yields every appended-to buffer as [id, output], longest-dirty first', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'x')
    store.append(s2, 'y')
    store.append(s1, 'z') // s1 stays first: dirty since before s2
    expect([...store.dirtyEntries()]).toEqual([
      [s1, 'xz'],
      [s2, 'y']
    ])
  })

  it('markClean drops a session from dirtyEntries until its next append', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'x')
    store.append(s2, 'y')
    store.markClean(s1)
    expect([...store.dirtyEntries()]).toEqual([[s2, 'y']])
    store.markClean(s2)
    store.append(s1, 'more')
    // Re-dirtied after s2 was cleaned → it is the only, newest dirty entry.
    expect([...store.dirtyEntries()]).toEqual([[s1, 'xmore']])
    expect(store.snapshot(s2)).toBe('y') // clean buffers are kept, just not re-flushed
  })

  it('tolerates markClean while iterating dirtyEntries (the flush pattern)', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'x')
    store.append(s2, 'y')
    const seen: string[] = []
    for (const [id] of store.dirtyEntries()) {
      seen.push(id)
      store.markClean(id)
    }
    expect(seen).toEqual([s1, s2])
    expect([...store.dirtyEntries()]).toEqual([])
  })

  it('delete clears the dirty flag along with the buffer', () => {
    const store = new RingBufferScrollbackStore()
    store.append(s1, 'x')
    store.delete(s1)
    expect([...store.dirtyEntries()]).toEqual([])
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
    expect([...store.dirtyEntries()]).toEqual([])
    expect(store.snapshot(s1)).toBeUndefined()
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

  describe('size markers (restored history replays at its recorded size)', () => {
    it('records the size ahead of the next output, once', () => {
      const store = new RingBufferScrollbackStore()
      store.setSize(s1, 80, 24)
      store.append(s1, 'a')
      store.setSize(s1, 80, 24) // unchanged: no new marker
      store.append(s1, 'b')
      store.setSize(s1, 200, 50)
      store.append(s1, 'c')
      expect(store.snapshot(s1)).toBe(`${size(80, 24)}ab${size(200, 50)}c`)
    })

    it('writes nothing for a size alone (no output, no history)', () => {
      const store = new RingBufferScrollbackStore()
      store.setSize(s1, 80, 24)
      expect(store.snapshot(s1)).toBeUndefined()
      expect([...store.dirtyEntries()]).toEqual([])
    })

    it('records only the last of several sizes set between outputs', () => {
      const store = new RingBufferScrollbackStore()
      store.setSize(s1, 80, 24)
      store.setSize(s1, 120, 30)
      store.append(s1, 'x')
      expect(store.snapshot(s1)).toBe(`${size(120, 30)}x`)
    })

    it('repeats the marker so a long history keeps it after eviction', () => {
      const store = new RingBufferScrollbackStore(3 * SIZE_MARKER_INTERVAL)
      store.setSize(s1, 200, 50)
      const chunk = 'x'.repeat(SIZE_MARKER_INTERVAL / 4)
      for (let i = 0; i < 40; i++) store.append(s1, chunk)
      const out = store.snapshot(s1)!
      // The first marker was evicted long ago; a repeat stays near the head.
      expect(out.indexOf(size(200, 50))).toBeGreaterThanOrEqual(0)
      expect(out.indexOf(size(200, 50))).toBeLessThanOrEqual(SIZE_MARKER_INTERVAL)
    })

    it('forgets the size with the buffer', () => {
      const store = new RingBufferScrollbackStore()
      store.setSize(s1, 200, 50)
      store.delete(s1)
      store.append(s1, 'x')
      expect(store.snapshot(s1)).toBe('x')
    })
  })
})
