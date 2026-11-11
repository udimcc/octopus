/**
 * One-time split of a pre-v13 scrollback row against the daemon replay (§6.6).
 * Returns the frozen-history part: what `saved` holds that the replay does not.
 */
import { describe, it, expect } from 'vitest'
import { splitLegacyScrollback } from './split-legacy-scrollback'

describe('splitLegacyScrollback (§6.6)', () => {
  it('saved wholly covered by the replay → no history', () => {
    expect(splitLegacyScrollback('$ ls\r\nfoo\r\n', '$ ls\r\nfoo\r\n$ pwd\r\n')).toBe('')
    expect(splitLegacyScrollback('foo\r\n$ ', 'boot\r\n$ ls\r\nfoo\r\n$ ')).toBe('')
  })

  it('restored history + daemon output → keeps only the part before the replay start', () => {
    // Non-repeating, so the needle occurs once; the saved daemon part holds all of it.
    const ring = Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join('')
    expect(splitLegacyScrollback('OLD HISTORY|' + ring, ring + 'more')).toBe('OLD HISTORY|')
  })

  it('a saved daemon part shorter than the needle splits at the tail overlap', () => {
    const ringAtSave = '$ make\r\n[ 10%] Building CXX object foo.o\r\n'
    const replay = ringAtSave + 'x'.repeat(5000)
    expect(splitLegacyScrollback('OLD HISTORY|' + ringAtSave, replay)).toBe('OLD HISTORY|')
  })

  it('a tail overlap shorter than the minimum is treated as a coincidence (keeps data)', () => {
    expect(splitLegacyScrollback('OLD HISTORY|$ ', '$ make')).toBe('OLD HISTORY|$ ')
  })

  it('no overlap (the daemon evicted it all) → keeps all of saved', () => {
    expect(splitLegacyScrollback('evicted output', 'new ring')).toBe('evicted output')
  })

  it('an empty side keeps saved as-is', () => {
    expect(splitLegacyScrollback('', 'ring')).toBe('')
    expect(splitLegacyScrollback('saved', '')).toBe('saved')
  })

  it('splits at the LAST occurrence of the replay start (repeated output)', () => {
    // The replay's needle also occurs earlier in the history (an identical redraw);
    // the split keeps the earlier copy as history.
    const block = 'B'.repeat(4096)
    expect(splitLegacyScrollback('H' + block + 'H' + block, block + 'new')).toBe('H' + block + 'H')
  })

  it('a short replay that merely occurs in saved never cuts it (empty daemon ring)', () => {
    // Regression from real data: a legacy row that was itself a replay starts with the
    // daemon's mode-restore sequence. A PTY with an empty ring replays ONLY that
    // sequence, so the old "replay start occurs in saved" rule cut at 0 and lost it all.
    const restore = '\x1b[?25l\x1b[?1004h\x1b[?2004h'
    const saved = restore + '\x1b[2K\x1b[1B'.repeat(40) + 'claude conversation text'
    expect(splitLegacyScrollback(saved, restore)).toBe(saved)
    expect(splitLegacyScrollback(saved, restore + '\x1b]133;D;0\x07$ ')).toBe(saved)
  })

  it('drops only a tail the replay starts with, not text after an inner match', () => {
    const ring = Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join('')
    // The replay's start occurs inside saved, but saved continues with text the
    // replay does not repeat: nothing provably duplicated → keep it all.
    const saved = 'OLD|' + ring + 'NOT IN THE RING'
    expect(splitLegacyScrollback(saved, ring + 'more')).toBe(saved)
  })

  it('compares only a bounded needle, so huge buffers still split correctly', () => {
    const history = 'H'.repeat(10_000)
    const ring = 'R'.repeat(3_000) + 'x'.repeat(10_000)
    expect(splitLegacyScrollback(history + ring.slice(0, 8_000), ring)).toBe(history)
  })
})
