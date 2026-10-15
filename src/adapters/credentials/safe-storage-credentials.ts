/**
 * `CredentialsProvider` over Electron's `safeStorage` (DESIGN "Jira import", I16):
 * each ref is encrypted at rest as `<credentialsDir>/<ref>.bin` (mode 0600), never
 * persisted in the DB or `settings.json`, and never logged.
 *
 * `safeStorage` is OS-keychain-backed (libsecret on Linux) and is only usable after
 * Electron's `app.whenReady()` resolves. `bootstrap()` (`src/main/index.ts`) runs
 * earlier than that, so this adapter must defer every `safeStorage` call to method
 * invocation time — it is NEVER touched from the constructor.
 *
 * `SafeStorageLike` is declared locally rather than imported from `electron`, so
 * this adapter has no Electron dependency and stays trivially testable; the
 * composition root (main-only) injects the real `safeStorage` singleton.
 */

import { randomUUID } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'
import type { CredentialsProvider } from '../../ports/credentials-provider'

/** The subset of Electron's `safeStorage` this adapter needs — see module doc. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /**
   * Linux-only (absent elsewhere). `'basic_text'` means the OS keyring is
   * unavailable and secrets are NOT actually encrypted at rest.
   */
  getSelectedStorageBackend?(): string
}

/** Minimal fs surface this adapter uses, injectable for tests. */
export interface SafeStorageCredentialsFs {
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<string | undefined>
  chmod: (path: string, mode: number) => Promise<void>
  writeFile: (path: string, data: Buffer, options: { mode: number }) => Promise<void>
  readFile: (path: string) => Promise<Buffer>
  rename: (oldPath: string, newPath: string) => Promise<void>
  unlink: (path: string) => Promise<void>
  access: (path: string) => Promise<void>
}

export interface SafeStorageCredentialsOptions {
  /** Injected for tests; defaults to `node:fs/promises`. */
  readonly fs?: SafeStorageCredentialsFs
  /** Called at most once per process if the OS backend is `basic_text`. Never passed the secret. */
  readonly warn?: (message: string) => void
}

/** Refs map 1:1 to filenames, so only a conservative charset is accepted. */
const REF_PATTERN = /^[a-z0-9-]+$/

const defaultFs: SafeStorageCredentialsFs = {
  mkdir: (path, options) => fsPromises.mkdir(path, options),
  chmod: (path, mode) => fsPromises.chmod(path, mode),
  writeFile: (path, data, options) => writeFileDurable(path, data, options.mode),
  readFile: (path) => fsPromises.readFile(path),
  rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
  unlink: (path) => fsPromises.unlink(path),
  access: (path) => fsPromises.access(path)
}

export class SafeStorageCredentials implements CredentialsProvider {
  private readonly safeStorage: SafeStorageLike
  private readonly dir: string
  private readonly fs: SafeStorageCredentialsFs
  private readonly warn: (message: string) => void
  private warnedBasicText = false

  constructor(
    safeStorage: SafeStorageLike,
    dir: string,
    options: SafeStorageCredentialsOptions = {}
  ) {
    this.safeStorage = safeStorage
    this.dir = dir
    this.fs = options.fs ?? defaultFs
    this.warn = options.warn ?? ((message) => console.warn(`[octopus] ${message}`))
  }

  /** Decrypt and return the secret for `credentialsRef`. Throws if none is set. */
  async resolve(credentialsRef: string): Promise<string> {
    const path = this.refPath(credentialsRef)
    let encrypted: Buffer
    try {
      encrypted = await this.fs.readFile(path)
    } catch (err) {
      if (isEnoent(err)) {
        throw new Error(`no credential is set for '${credentialsRef}'`)
      }
      throw err
    }
    return this.safeStorage.decryptString(encrypted)
  }

  /** Set (encrypt) or clear (`null`) the secret for `ref`. */
  async set(ref: string, secret: string | null): Promise<void> {
    const path = this.refPath(ref)
    if (secret === null) {
      await this.deleteFile(path)
      return
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('cannot store credential: secure storage unavailable')
    }
    this.warnIfBasicTextBackend()
    // Encrypt before touching the filesystem, so a bad safeStorage call never
    // leaves a half-written file behind.
    const encrypted = this.safeStorage.encryptString(secret)
    await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    // mkdir's `mode` is masked by umask and ignored entirely for a dir that
    // already exists — chmod explicitly (mirrors `ensureAppDirs`, paths.ts).
    await this.fs.chmod(this.dir, 0o700)
    await this.writeAtomic(path, encrypted)
  }

  /** Whether a secret is currently stored for `ref`. */
  async has(ref: string): Promise<boolean> {
    try {
      await this.fs.access(this.refPath(ref))
      return true
    } catch {
      return false
    }
  }

  private refPath(ref: string): string {
    if (!REF_PATTERN.test(ref)) {
      throw new Error(`invalid credentials ref '${ref}'`)
    }
    return join(this.dir, `${ref}.bin`)
  }

  /**
   * Write via a uniquely named temp file (mode 0600) + rename, so neither a crash nor
   * two concurrent `set()`s ever leave a truncated secret; the temp file is removed if
   * the write or rename fails.
   */
  private async writeAtomic(path: string, data: Buffer): Promise<void> {
    const tmp = `${path}.tmp-${randomUUID()}`
    try {
      await this.fs.writeFile(tmp, data, { mode: 0o600 })
      await this.fs.rename(tmp, path)
    } catch (err) {
      await this.fs.unlink(tmp).catch(() => undefined)
      throw err
    }
  }

  private async deleteFile(path: string): Promise<void> {
    try {
      await this.fs.unlink(path)
    } catch (err) {
      if (!isEnoent(err)) {
        throw err
      }
    }
  }

  /** Warn (without the secret) at most once per process if the Linux backend isn't a real keyring. */
  private warnIfBasicTextBackend(): void {
    if (this.warnedBasicText) {
      return
    }
    const backend = this.safeStorage.getSelectedStorageBackend?.()
    if (backend === 'basic_text') {
      this.warnedBasicText = true
      this.warn(
        'secrets are being stored with the basic_text safeStorage backend (no OS keyring available) — not actually encrypted at rest'
      )
    }
  }
}

/** Create `path` exclusively (`wx`), write, and fsync before close, so the rename that
 * follows publishes fully-written bytes even across a power loss. */
async function writeFileDurable(path: string, data: Buffer, mode: number): Promise<void> {
  const handle = await fsPromises.open(path, 'wx', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** True iff `err` is a Node filesystem error with code `ENOENT` (path absent). */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
