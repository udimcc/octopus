import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { createServer, Server } from 'node:net'
import { existsSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeExisting, removeStaleSocket, acquireSingleton } from './singleton-lock'

const tempDir = mkdtempSync(join(tmpdir(), 'octopus-singleton-'))
let seq = 0
const servers: Server[] = []
const paths: string[] = []

function uniquePath(): string {
  const p = join(tempDir, `sock-${process.pid}-${seq++}`)
  paths.push(p)
  return p
}

function listenReal(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    servers.push(server)
    server.once('error', reject)
    server.listen(socketPath, () => resolve(server))
  })
}

function addrInUse(): NodeJS.ErrnoException {
  const err = new Error('bind failed') as NodeJS.ErrnoException
  err.code = 'EADDRINUSE'
  return err
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  for (const p of paths.splice(0)) {
    if (existsSync(p)) {
      try {
        unlinkSync(p)
      } catch {
        // best-effort cleanup
      }
    }
  }
})

describe('acquireSingleton', () => {
  it('returns true and calls tryListen once when the bind succeeds', async () => {
    const socketPath = uniquePath()
    let calls = 0
    const tryListen = async (): Promise<void> => {
      calls++
    }
    const owned = await acquireSingleton(socketPath, tryListen)
    expect(owned).toBe(true)
    expect(calls).toBe(1)
  })

  it('propagates a non-EADDRINUSE error from tryListen', async () => {
    const socketPath = uniquePath()
    const tryListen = async (): Promise<void> => {
      const err = new Error('permission denied') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }
    await expect(acquireSingleton(socketPath, tryListen)).rejects.toThrow('permission denied')
  })

  it('returns false when EADDRINUSE and a live daemon is listening', async () => {
    const socketPath = uniquePath()
    await listenReal(socketPath)
    let calls = 0
    const tryListen = async (): Promise<void> => {
      calls++
      throw addrInUse()
    }
    const owned = await acquireSingleton(socketPath, tryListen)
    expect(owned).toBe(false)
    expect(calls).toBe(1)
  })

  it('clears a stale socket file and retries once, returning true', async () => {
    const socketPath = uniquePath()
    writeFileSync(socketPath, '')
    expect(existsSync(socketPath)).toBe(true)
    let calls = 0
    const tryListen = async (): Promise<void> => {
      calls++
      if (calls === 1) {
        throw addrInUse()
      }
    }
    const owned = await acquireSingleton(socketPath, tryListen)
    expect(owned).toBe(true)
    expect(calls).toBe(2)
    expect(existsSync(socketPath)).toBe(false)
  })
})

describe('probeExisting', () => {
  it('returns false immediately for a nonexistent path', async () => {
    const socketPath = uniquePath()
    expect(await probeExisting(socketPath)).toBe(false)
  })

  it('returns true when a real server is listening on the path', async () => {
    const socketPath = uniquePath()
    await listenReal(socketPath)
    expect(await probeExisting(socketPath)).toBe(true)
  })

  it('returns false for a stale (non-socket) file that refuses connection', async () => {
    const socketPath = uniquePath()
    writeFileSync(socketPath, '')
    expect(await probeExisting(socketPath)).toBe(false)
  })
})

describe('removeStaleSocket', () => {
  it('unlinks an existing file', () => {
    const socketPath = uniquePath()
    writeFileSync(socketPath, '')
    expect(existsSync(socketPath)).toBe(true)
    removeStaleSocket(socketPath)
    expect(existsSync(socketPath)).toBe(false)
  })

  it('is a no-op when the file is absent', () => {
    const socketPath = uniquePath()
    expect(() => removeStaleSocket(socketPath)).not.toThrow()
  })
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})
