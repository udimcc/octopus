import { describe, it, expect } from 'vitest'
import { RingBuffer } from './ring-buffer'

describe('RingBuffer (§6.6)', () => {
  it('retains everything while under the cap (append → snapshot round-trip)', () => {
    const rb = new RingBuffer(100)
    rb.append('hello ')
    rb.append('world')
    expect(rb.snapshot()).toBe('hello world')
    expect(rb.byteLength).toBe(11)
  })

  it('evicts oldest chunks once the total exceeds the cap', () => {
    const rb = new RingBuffer(10)
    rb.append('aaaaa') // 5
    rb.append('bbbbb') // 10 total — at cap, no eviction yet
    expect(rb.snapshot()).toBe('aaaaabbbbb')
    rb.append('ccccc') // 15 > 10 → evict 'aaaaa'
    expect(rb.snapshot()).toBe('bbbbbccccc')
    expect(rb.byteLength).toBe(10)
  })

  it('keeps at least the newest chunk even if it alone exceeds the cap', () => {
    const rb = new RingBuffer(4)
    rb.append('ab')
    // A single chunk larger than the cap is truncated to its tail on append,
    // and eviction never drops the sole remaining chunk.
    rb.append('123456') // > cap(4) → truncated to '3456'
    expect(rb.snapshot()).toBe('3456')
    expect(rb.byteLength).toBe(4)
  })

  it('truncates an oversized single chunk to its byte-tail without splitting multibyte chars', () => {
    const rb = new RingBuffer(4)
    // '€' is 3 UTF-8 bytes; '€€' is 6 > 4. The tail must be a whole '€' (3 bytes),
    // never a half-encoded byte sequence.
    rb.append('€€')
    expect(rb.snapshot()).toBe('€')
    expect(rb.byteLength).toBe(3)
  })

  it('counts UTF-8 bytes for the cap', () => {
    const rb = new RingBuffer(10)
    rb.append('€€€') // 9 bytes
    expect(rb.byteLength).toBe(9)
    rb.append('x') // 10 total — still at cap
    expect(rb.byteLength).toBe(10)
    rb.append('y') // 11 > 10 → evict the 9-byte chunk
    expect(rb.snapshot()).toBe('xy')
    expect(rb.byteLength).toBe(2)
  })

  it('ignores empty appends', () => {
    const rb = new RingBuffer(10)
    rb.append('')
    expect(rb.snapshot()).toBe('')
    expect(rb.byteLength).toBe(0)
  })

  it('clear() drops all retained output', () => {
    const rb = new RingBuffer(10)
    rb.append('data')
    rb.clear()
    expect(rb.snapshot()).toBe('')
    expect(rb.byteLength).toBe(0)
  })
})
