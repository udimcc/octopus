/**
 * A minimal `fetch` over `node:https` that trusts the OS CA bundle in addition to
 * Node's bundled roots (DESIGN §13.7). The LiteLLM gateway's certificate is issued by
 * the internal `israel.final` CA, which lives only in the system store
 * (`/etc/ssl/certs/ca-certificates.crt`) — Node's own fetch (undici) trusts it only
 * when `NODE_EXTRA_CA_CERTS` is inherited from the launching shell, so a desktop
 * launcher would see every call fail as "unreachable". `.npmrc`'s `cafile` exists for
 * the same reason.
 *
 * macOS has no PEM bundle file: the corporate root (`Final Root CA`) lives only in
 * the System keychain, so on darwin the extra CAs are exported once, lazily and
 * asynchronously, with `security find-certificate -a -p` from the System keychain
 * and the system roots keychain ({@link readDarwinKeychainCas}).
 *
 * Only what `LiteLLMJiraSource` needs: a buffered response body, `AbortSignal`
 * support (the adapter's timeout), and socket/TLS errors that keep their `code`
 * (e.g. `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) so the "unreachable" message is diagnosable.
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Agent, request as httpsRequest } from 'node:https'
import { rootCertificates } from 'node:tls'
import type { JiraFetch } from './litellm-jira-source'

/** Debian/Ubuntu system CA bundle (Linux). */
export const SYSTEM_CA_BUNDLE_PATH = '/etc/ssl/certs/ca-certificates.crt'

/** macOS keychains whose certificates are trusted in addition to Node's roots. */
export const DARWIN_KEYCHAINS = [
  '/Library/Keychains/System.keychain',
  '/System/Library/Keychains/SystemRootCertificates.keychain'
] as const

/** Absolute path, so a PATH-less GUI launch still finds it. */
const SECURITY_BIN = '/usr/bin/security'
/** A keychain export is a few hundred KB; give it room and a bound. */
const SECURITY_MAX_BUFFER = 16 * 1024 * 1024
const SECURITY_TIMEOUT_MS = 10_000

/** Runs `file args…` and resolves to its stdout. Injected for tests. */
export type ExecFileText = (file: string, args: readonly string[]) => Promise<string>

/** A CA bundle reader: sync on Linux (a file read), async on darwin (a subprocess). */
export type CaBundleReader = () => string | undefined | Promise<string | undefined>

/** Responses above this are rejected rather than buffered without bound. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export interface HttpsFetchDeps {
  /** Injected for tests; defaults to `node:https` `request`. */
  readonly request?: typeof httpsRequest
  /**
   * Returns the extra CA bundle PEM (or a promise of it), or `undefined` when
   * unavailable. Read once, on first fetch. Defaults to {@link systemCaBundleReader}.
   */
  readonly readCaBundle?: CaBundleReader
  /** Host platform; selects the default reader. Defaults to `process.platform`. */
  readonly platform?: string
}

/** Best-effort read of the system CA bundle: an unreadable/missing file just means
 * Node's bundled roots alone. */
export function readSystemCaBundle(platform: string = process.platform): string | undefined {
  if (platform !== 'linux') return undefined
  try {
    return readFileSync(SYSTEM_CA_BUNDLE_PATH, 'utf8')
  } catch {
    return undefined
  }
}

const execFileText: ExecFileText = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: SECURITY_MAX_BUFFER, timeout: SECURITY_TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })

const PEM_BEGIN = '-----BEGIN CERTIFICATE-----'

/**
 * Best-effort export of the macOS System + system-roots keychains as one PEM bundle.
 * A keychain that fails to export (missing, locked-down host) is skipped; if none
 * yields a certificate the result is `undefined` (Node's bundled roots alone).
 */
export async function readDarwinKeychainCas(
  exec: ExecFileText = execFileText
): Promise<string | undefined> {
  const exports = await Promise.all(
    DARWIN_KEYCHAINS.map((keychain) =>
      exec(SECURITY_BIN, ['find-certificate', '-a', '-p', keychain]).catch(() => '')
    )
  )
  const pems = exports.map((pem) => pem.trim()).filter((pem) => pem.includes(PEM_BEGIN))
  return pems.length > 0 ? `${pems.join('\n')}\n` : undefined
}

/** The default extra-CA reader for `platform`: the PEM file on Linux, the keychains on darwin. */
export function systemCaBundleReader(platform: string): CaBundleReader {
  return platform === 'darwin' ? () => readDarwinKeychainCas() : () => readSystemCaBundle(platform)
}

function makeAgent(bundle: string | undefined): Agent {
  return new Agent({
    keepAlive: true,
    ca: bundle === undefined ? [...rootCertificates] : [...rootCertificates, bundle]
  })
}

export function createHttpsFetch(deps: HttpsFetchDeps = {}): JiraFetch {
  const request = deps.request ?? httpsRequest
  const readCaBundle = deps.readCaBundle ?? systemCaBundleReader(deps.platform ?? process.platform)
  // Built lazily on first call, so app startup never reads the bundle. A sync reader
  // (Linux) yields the agent immediately; an async one (darwin) is shared by every
  // fetch that arrives while it is pending, so the keychains are exported once.
  let agent: Agent | undefined
  let pendingAgent: Promise<Agent> | undefined
  const getAgent = (): Agent | Promise<Agent> => {
    if (agent !== undefined) return agent
    if (pendingAgent !== undefined) return pendingAgent
    const bundle = readCaBundle()
    if (bundle instanceof Promise) {
      pendingAgent = bundle
        .catch(() => undefined)
        .then((b) => {
          agent = makeAgent(b)
          return agent
        })
      return pendingAgent
    }
    agent = makeAgent(bundle)
    return agent
  }

  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      if (init.signal.aborted) {
        reject(init.signal.reason)
        return
      }
      const ready = getAgent()
      if (ready instanceof Agent) {
        send(ready)
        return
      }
      ready.then((a) => {
        // The signal may have fired while the CA bundle was loading.
        if (init.signal.aborted) {
          reject(init.signal.reason)
          return
        }
        send(a)
      }, reject)

      function send(agent: Agent): void {
        const req = request(url, {
          method: init.method,
          headers: { ...init.headers, 'Content-Length': String(Buffer.byteLength(init.body)) },
          agent
        })
        // The signal covers the whole exchange, body included — so a timeout while the
        // body streams rejects with the signal's `TimeoutError`, like real fetch.
        const onAbort = (): void => {
          req.destroy(init.signal.reason)
        }
        init.signal.addEventListener('abort', onAbort, { once: true })
        const settle = (): void => init.signal.removeEventListener('abort', onAbort)

        req.on('error', (error) => {
          settle()
          reject(error)
        })
        req.on('response', (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new Error('response too large'))
              return
            }
            chunks.push(chunk)
          })
          res.on('error', (error) => {
            settle()
            reject(error)
          })
          res.on('end', () => {
            settle()
            const headers = new Headers()
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue
              for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
            }
            const status = res.statusCode ?? 0
            const nullBody = status === 204 || status === 205 || status === 304
            try {
              resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, headers }))
            } catch (error) {
              // e.g. a status outside 200-599 — reject rather than throw from the listener.
              reject(error)
            }
          })
        })
        req.end(init.body)
      }
    })
}
