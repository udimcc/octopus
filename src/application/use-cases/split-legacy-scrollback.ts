/**
 * One-time split of a legacy (pre-v13) scrollback row on its first re-attach
 * (DESIGN §6.6). Before v13 the row held one `data` blob: main's whole buffer at the
 * last save. After a fresh spawn that buffer was (restored history + output since
 * the spawn); otherwise it was output the daemon still holds. Re-attach must show
 * only the part the daemon replay does NOT already contain, or it double-prints.
 *
 * Both strings are slices of the same byte stream, so the boundary is found by text
 * overlap with the replay (`replay`, main's buffer right after attach):
 *
 *   1. `saved` starts inside the replay → it is wholly covered (it ends no later than
 *      the replay does) → no history.
 *   2. A tail of `saved` is a prefix of the replay → history is everything before
 *      that tail (the longest such tail, at least {@link MIN_TAIL_OVERLAP} chars).
 *   3. No overlap → all of `saved` precedes the replay (the daemon has evicted it) →
 *      keep it all.
 *
 * Case 2 only ever drops text the replay provably shows again, so it cannot lose
 * output. An earlier version cut `saved` wherever the replay's first 4 KB occurred in
 * it. A short replay made that needle tiny: a daemon PTY with an empty ring replays
 * only its mode-restore sequence (`\x1b[?25l\x1b[?1004h\x1b[?2004h`), which a legacy
 * row that was itself a replay STARTS with. The cut landed at 0 and the whole saved
 * history was lost.
 *
 * Case 1 still trusts a 4 KB prefix match. That case is the common daemon row (main
 * saved what the daemon replayed). A wrong match needs 4 KB of identical output at
 * the very start of `saved`. When in doubt this keeps data: a stray duplicate beats
 * lost history. Pure, and unit-tested in isolation.
 */

/** Characters of `saved`'s start looked up in the replay (case 1). */
const NEEDLE_LENGTH = 4096
/** Shortest tail overlap (case 2) trusted as the boundary rather than a coincidence. */
const MIN_TAIL_OVERLAP = 32

export function splitLegacyScrollback(saved: string, replay: string): string {
  if (saved === '' || replay === '') {
    return saved
  }
  if (replay.includes(saved.slice(0, NEEDLE_LENGTH))) {
    return ''
  }
  const overlap = suffixPrefixOverlap(saved, replay)
  return overlap >= MIN_TAIL_OVERLAP ? saved.slice(0, saved.length - overlap) : saved
}

/**
 * Length of the longest suffix of `a` that is also a prefix of `b`. Uses KMP: the
 * failure function of `b`, then one pass over `a`'s tail. Linear in both, so a
 * 500 KB row and replay cost one pass each.
 */
function suffixPrefixOverlap(a: string, b: string): number {
  const m = Math.min(a.length, b.length)
  // fail[i] = length of the longest proper prefix of b[0..i] that is also its suffix.
  const fail = new Int32Array(m)
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && b[i] !== b[k]) {
      k = fail[k - 1]
    }
    if (b[i] === b[k]) {
      k++
    }
    fail[i] = k
  }
  // An overlap is at most m long, so scanning a's last m chars is enough.
  let k = 0
  for (let i = a.length - m; i < a.length; i++) {
    while (k > 0 && (k === m || a[i] !== b[k])) {
      k = fail[k - 1]
    }
    if (a[i] === b[k]) {
      k++
    }
  }
  return k
}
