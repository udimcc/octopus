import { describe, it, expect } from 'vitest'
import { LineSplitter } from './line-splitter'

function collect(): { lines: string[]; splitter: LineSplitter } {
  const lines: string[] = []
  return { lines, splitter: new LineSplitter((l) => lines.push(l)) }
}

describe('LineSplitter', () => {
  it('emits complete lines from a single chunk', () => {
    const { lines, splitter } = collect()
    splitter.push('a\nb\nc\n')
    expect(lines).toEqual(['a', 'b', 'c'])
  })

  it('joins a line split across chunk boundaries', () => {
    const { lines, splitter } = collect()
    splitter.push('hel')
    splitter.push('lo\nwor')
    splitter.push('ld\n')
    expect(lines).toEqual(['hello', 'world'])
  })

  it('strips a trailing CR (CRLF)', () => {
    const { lines, splitter } = collect()
    splitter.push('a\r\nb\r\n')
    expect(lines).toEqual(['a', 'b'])
  })

  it('flushes a trailing unterminated line on end()', () => {
    const { lines, splitter } = collect()
    splitter.push('no newline here')
    expect(lines).toEqual([])
    splitter.end()
    expect(lines).toEqual(['no newline here'])
  })

  it('end() with no pending data emits nothing', () => {
    const { lines, splitter } = collect()
    splitter.push('x\n')
    splitter.end()
    expect(lines).toEqual(['x'])
  })

  it('preserves empty lines between newlines', () => {
    const { lines, splitter } = collect()
    splitter.push('a\n\nb\n')
    expect(lines).toEqual(['a', '', 'b'])
  })
})
