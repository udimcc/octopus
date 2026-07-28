import { describe, it, expect } from 'vitest'
import {
  encodeControl,
  encodeData,
  FrameDecoder,
  FRAME_KIND,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ControlMessage,
  type Frame
} from './daemon-protocol'

/** Decode a single self-contained buffer, asserting exactly one frame comes out. */
function decodeOne(buf: Buffer): Frame {
  const frames = new FrameDecoder().push(buf)
  expect(frames).toHaveLength(1)
  return frames[0]
}

describe('daemon-protocol framing', () => {
  it('round-trips a control message', () => {
    const msg: ControlMessage = { type: 'hello', requestId: 7, protocolVersion: PROTOCOL_VERSION }
    const frame = decodeOne(encodeControl(msg))
    expect(frame.kind).toBe('control')
    if (frame.kind === 'control') {
      expect(frame.message).toEqual(msg)
    }
  })

  it('round-trips a data frame (sessionId + raw bytes)', () => {
    const frame = decodeOne(encodeData('sess-1', 'ls -la\n'))
    expect(frame.kind).toBe('data')
    if (frame.kind === 'data') {
      expect(frame.sessionId).toBe('sess-1')
      expect(frame.data).toBe('ls -la\n')
    }
  })

  it('preserves multibyte UTF-8 in data frames', () => {
    const frame = decodeOne(encodeData('s', '€ ✓ 日本語\n'))
    if (frame.kind === 'data') {
      expect(frame.data).toBe('€ ✓ 日本語\n')
    }
  })

  it('reassembles a frame split across multiple chunks', () => {
    const whole = encodeControl({ type: 'listSessions', requestId: 1 })
    const dec = new FrameDecoder()
    // Split mid-header and mid-payload.
    expect(dec.push(whole.subarray(0, 2))).toHaveLength(0)
    expect(dec.push(whole.subarray(2, 6))).toHaveLength(0)
    const frames = dec.push(whole.subarray(6))
    expect(frames).toHaveLength(1)
    expect(frames[0].kind).toBe('control')
  })

  it('yields multiple frames delivered in one chunk', () => {
    const a = encodeControl({ type: 'detach', sessionId: 'a' })
    const b = encodeData('a', 'x')
    const c = encodeControl({ type: 'close', requestId: 9, sessionId: 'a' })
    const frames = new FrameDecoder().push(Buffer.concat([a, b, c]))
    expect(frames.map((f) => f.kind)).toEqual(['control', 'data', 'control'])
  })

  it('retains a partial tail after emitting complete frames', () => {
    const a = encodeData('s', 'hello')
    const b = encodeData('s', 'world')
    const dec = new FrameDecoder()
    // Feed a full frame + the first 3 bytes of the next.
    const frames1 = dec.push(Buffer.concat([a, b.subarray(0, 3)]))
    expect(frames1).toHaveLength(1)
    const frames2 = dec.push(b.subarray(3))
    expect(frames2).toHaveLength(1)
    if (frames2[0].kind === 'data') {
      expect(frames2[0].data).toBe('world')
    }
  })

  it('throws on a frame that declares a length over the cap', () => {
    const bad = Buffer.alloc(5)
    bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    bad.writeUInt8(FRAME_KIND.control, 4)
    expect(() => new FrameDecoder().push(bad)).toThrow(/exceeds cap/)
  })

  it('throws on an unknown frame kind', () => {
    const bad = Buffer.alloc(6)
    bad.writeUInt32BE(1, 0)
    bad.writeUInt8(0x7f, 4) // unknown kind
    bad.writeUInt8(0x00, 5)
    expect(() => new FrameDecoder().push(bad)).toThrow(/unknown frame kind/)
  })

  it('handles an empty-data frame', () => {
    const frame = decodeOne(encodeData('s', ''))
    if (frame.kind === 'data') {
      expect(frame.data).toBe('')
      expect(frame.sessionId).toBe('s')
    }
  })
})
