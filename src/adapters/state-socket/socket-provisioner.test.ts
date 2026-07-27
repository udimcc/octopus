import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  socketDirFor,
  socketPathFor,
  createSocketProvisioner
} from './socket-provisioner'
import { asSessionId } from '../../domain/ids'

describe('socket path shape (§9.2, pure)', () => {
  it('computes /<base>/octopus-<uid>/ for the dir', () => {
    expect(socketDirFor(1000, '/tmp')).toBe('/tmp/octopus-1000')
  })

  it('computes /<base>/octopus-<uid>/session-<id>.sock for the socket', () => {
    expect(socketPathFor(1000, asSessionId('abc'), '/tmp')).toBe(
      '/tmp/octopus-1000/session-abc.sock'
    )
  })
})

describe('createSocketProvisioner (§9.2, §10 dormant seam)', () => {
  let base: string
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true })
  })

  it('socketPathFor is pure — it never creates anything (nothing is bound in V1)', () => {
    base = mkdtempSync(join(tmpdir(), 'octopus-sock-'))
    const p = createSocketProvisioner(1000, base)
    const path = p.socketPathFor(asSessionId('s1'))
    expect(path).toBe(join(base, 'octopus-1000', 'session-s1.sock'))
    // The parent dir is NOT created just by computing a path.
    expect(existsSync(join(base, 'octopus-1000'))).toBe(false)
    // And of course no socket file exists (nothing binds a listener in V1).
    expect(existsSync(path)).toBe(false)
  })

  it('ensureSocketDir creates the private (0o700) parent dir and is idempotent', () => {
    base = mkdtempSync(join(tmpdir(), 'octopus-sock-'))
    const p = createSocketProvisioner(1000, base)
    p.ensureSocketDir()
    const dir = join(base, 'octopus-1000')
    expect(statSync(dir).isDirectory()).toBe(true)
    // 0o700: owner-only (a socket is a capability, §9.2).
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    // Idempotent (recursive mkdir) — a second call must not throw.
    expect(() => p.ensureSocketDir()).not.toThrow()
    // Still no socket file — provisioned, not bound.
    expect(readdirSync(dir)).toEqual([])
  })
})
