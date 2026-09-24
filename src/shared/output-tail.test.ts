import { describe, it, expect } from 'vitest'
import { OutputTail, OUTPUT_TAIL_MAX_BYTES } from './output-tail'

describe('OutputTail', () => {
  it('keeps everything while under the cap', () => {
    const tail = new OutputTail(100)
    tail.append('abc')
    tail.append('def')
    expect(tail.peek()).toBe('abcdef')
    expect(tail.length).toBe(6)
    expect(tail.drain()).toEqual(['abc', 'def'])
    expect(tail.length).toBe(0)
  })

  it('ignores empty appends', () => {
    const tail = new OutputTail(10)
    tail.append('')
    expect(tail.drain()).toEqual([])
  })

  it('truncates a single oversized chunk to its tail', () => {
    const tail = new OutputTail(10)
    tail.append('0123456789ABCDE')
    expect(tail.peek()).toBe('56789ABCDE')
    expect(tail.length).toBe(10)
  })

  /**
   * The regression that lost all re-attach history: a huge replay chunk followed by
   * one byte of live output. Dropping whole chunks oldest-first threw the replay away
   * entirely; the bound must be on BYTES, so the head chunk is trimmed in place.
   */
  it('trims the OLDEST chunk in place instead of dropping it whole', () => {
    const tail = new OutputTail(10)
    tail.append('HISTORY123') // exactly the cap
    tail.append('L') // one more byte
    expect(tail.peek()).toBe('ISTORY123L')
    expect(tail.length).toBe(10)
  })

  it('always retains exactly the newest `max` units across chunk boundaries', () => {
    const tail = new OutputTail(6)
    const chunks = ['aa', 'bbb', 'cccc', 'd']
    for (const c of chunks) tail.append(c)
    expect(tail.peek()).toBe(chunks.join('').slice(-6))
    expect(tail.peek()).toBe('bccccd')
    expect(tail.length).toBe(6)
  })

  it('drops a head chunk whose length exactly equals the excess', () => {
    const tail = new OutputTail(4)
    tail.append('ab')
    tail.append('cdef')
    expect(tail.peek()).toBe('cdef')
    expect(tail.length).toBe(4)
  })

  it('defaults to the shared ~500 KB bound', () => {
    const tail = new OutputTail()
    tail.append('x'.repeat(OUTPUT_TAIL_MAX_BYTES + 1000))
    expect(tail.length).toBe(OUTPUT_TAIL_MAX_BYTES)
  })
})
