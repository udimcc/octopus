import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SafeStorageCredentials,
  type SafeStorageLike,
  type SafeStorageCredentialsFs
} from './safe-storage-credentials'

/** An in-memory fake of the fs surface the adapter needs, so no real disk I/O happens. */
function fakeFs(): SafeStorageCredentialsFs & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>()
  return {
    files,
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    writeFile: vi.fn(async (path: string, data: Buffer) => {
      files.set(path, data)
    }),
    readFile: vi.fn(async (path: string) => {
      const data = files.get(path)
      if (data === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return data
    }),
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      const data = files.get(oldPath)
      if (data === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      files.delete(oldPath)
      files.set(newPath, data)
    }),
    unlink: vi.fn(async (path: string) => {
      if (!files.has(path)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      files.delete(path)
    }),
    access: vi.fn(async (path: string) => {
      if (!files.has(path)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
    })
  }
}

/** A fake `safeStorage` that "encrypts" by prefixing, so plaintext is never byte-identical
 * to the stored bytes. Throws if called before being armed, to catch a construction-time call. */
function fakeSafeStorage(
  options: { available?: boolean; backend?: string } = {}
): SafeStorageLike & {
  armed: boolean
} {
  const state = { available: options.available ?? true, armed: false }
  return {
    get armed() {
      return state.armed
    },
    isEncryptionAvailable: () => {
      state.armed = true
      return state.available
    },
    encryptString: (plainText: string) => {
      state.armed = true
      return Buffer.from(`ENC(${[...plainText].reverse().join('')})`)
    },
    decryptString: (encrypted: Buffer) => {
      state.armed = true
      const text = encrypted.toString()
      const match = /^ENC\((.*)\)$/.exec(text)
      if (!match) throw new Error('bad ciphertext')
      return [...match[1]].reverse().join('')
    },
    getSelectedStorageBackend: options.backend ? () => options.backend! : undefined
  }
}

describe('SafeStorageCredentials (DESIGN "Jira import", I16)', () => {
  const dir = '/fake/credentials'

  it('never calls safeStorage at construction time', () => {
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => {
        throw new Error('must not be called at construction')
      },
      encryptString: () => {
        throw new Error('must not be called at construction')
      },
      decryptString: () => {
        throw new Error('must not be called at construction')
      }
    }
    expect(() => new SafeStorageCredentials(safeStorage, dir)).not.toThrow()
  })

  it('set then resolve round-trips the secret', async () => {
    const fs = fakeFs()
    const safeStorage = fakeSafeStorage()
    const creds = new SafeStorageCredentials(safeStorage, dir, { fs })

    await creds.set('jira-api-key', 's3cr3t')
    const resolved = await creds.resolve('jira-api-key')

    expect(resolved).toBe('s3cr3t')
  })

  it('the stored bytes are not the plaintext secret', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    await creds.set('jira-api-key', 's3cr3t')

    for (const data of fs.files.values()) {
      expect(data.toString()).not.toContain('s3cr3t')
    }
  })

  it('writes with mode 0600', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    await creds.set('jira-api-key', 's3cr3t')

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ mode: 0o600 })
    )
  })

  it('writes via a randomly-named temp file then renames into place', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    await creds.set('jira-api-key', 's3cr3t')

    const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]
    const renameCall = (fs.rename as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(writeCall[0]).toMatch(/jira-api-key\.bin\.tmp-[0-9a-f-]+$/)
    expect(renameCall[0]).toBe(writeCall[0])
    expect(renameCall[1]).toBe(`${dir}/jira-api-key.bin`)
  })

  it('removes the temp file if the write fails', async () => {
    const fs = fakeFs()
    fs.writeFile = vi.fn(async () => {
      throw new Error('disk full')
    })
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    await expect(creds.set('jira-api-key', 's3cr3t')).rejects.toThrow('disk full')

    // unlink was attempted on the temp path (not left behind), even though it was
    // never actually created in this fake — assert the adapter tried to clean up.
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringMatching(/\.tmp-[0-9a-f-]+$/))
  })

  it('removes the temp file if the rename fails', async () => {
    const fs = fakeFs()
    const realRename = fs.rename
    fs.rename = vi.fn(async () => {
      throw new Error('rename failed')
    })
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    await expect(creds.set('jira-api-key', 's3cr3t')).rejects.toThrow('rename failed')

    const tmpPath = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(fs.unlink).toHaveBeenCalledWith(tmpPath)
    expect(realRename).not.toHaveBeenCalled()
  })

  it('set(ref, null) deletes the stored file', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })
    await creds.set('jira-api-key', 's3cr3t')
    expect(await creds.has('jira-api-key')).toBe(true)

    await creds.set('jira-api-key', null)

    expect(await creds.has('jira-api-key')).toBe(false)
  })

  it('clearing a never-set ref does not throw', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    await expect(creds.set('never-set', null)).resolves.toBeUndefined()
  })

  it('has() is false before set and true after', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    expect(await creds.has('jira-api-key')).toBe(false)
    await creds.set('jira-api-key', 's3cr3t')
    expect(await creds.has('jira-api-key')).toBe(true)
  })

  it('resolve on a missing ref throws a clear error', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    await expect(creds.resolve('missing')).rejects.toThrow(/no credential/i)
  })

  it('isEncryptionAvailable() === false makes set reject with a clear message, and never touches the fs', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage({ available: false }), dir, { fs })

    await expect(creds.set('jira-api-key', 's3cr3t')).rejects.toThrow(/secure storage unavailable/i)
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('warns (without the secret) exactly once when the Linux backend is basic_text', async () => {
    const fs = fakeFs()
    const warn = vi.fn()
    const creds = new SafeStorageCredentials(fakeSafeStorage({ backend: 'basic_text' }), dir, {
      fs,
      warn
    })

    await creds.set('jira-api-key', 's3cr3t')
    await creds.set('jira-api-key', 's3cr3t-again')

    expect(warn).toHaveBeenCalledTimes(1)
    const [message] = warn.mock.calls[0] as [string]
    expect(message).not.toContain('s3cr3t')
    expect(message).not.toContain('s3cr3t-again')
  })

  it('does not warn when the backend is a real keyring', async () => {
    const fs = fakeFs()
    const warn = vi.fn()
    const creds = new SafeStorageCredentials(fakeSafeStorage({ backend: 'gnome_libsecret' }), dir, {
      fs,
      warn
    })

    await creds.set('jira-api-key', 's3cr3t')

    expect(warn).not.toHaveBeenCalled()
  })

  it('rejects a ref outside the conservative filename charset', async () => {
    const fs = fakeFs()
    const creds = new SafeStorageCredentials(fakeSafeStorage(), dir, { fs })

    await expect(creds.set('../etc/passwd', 'x')).rejects.toThrow(/invalid credentials ref/i)
    await expect(creds.resolve('Has Spaces')).rejects.toThrow(/invalid credentials ref/i)
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })
})
