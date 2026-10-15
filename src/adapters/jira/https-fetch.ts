/**
 * A minimal `fetch` over `node:https` that trusts the OS CA bundle in addition to
 * Node's bundled roots (DESIGN §13.7). The LiteLLM gateway's certificate is issued by
 * the internal `israel.final` CA, which lives only in the system store
 * (`/etc/ssl/certs/ca-certificates.crt`) — Node's own fetch (undici) trusts it only
 * when `NODE_EXTRA_CA_CERTS` is inherited from the launching shell, so a desktop
 * launcher would see every call fail as "unreachable". `.npmrc`'s `cafile` exists for
 * the same reason.
 *
 * Only what `LiteLLMJiraSource` needs: a buffered response body, `AbortSignal`
 * support (the adapter's timeout), and socket/TLS errors that keep their `code`
 * (e.g. `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) so the "unreachable" message is diagnosable.
 */

import { readFileSync } from 'node:fs'
import { Agent, request as httpsRequest } from 'node:https'
import { rootCertificates } from 'node:tls'
import type { JiraFetch } from './litellm-jira-source'

/** Debian/Ubuntu system CA bundle (the host is Linux-only). */
export const SYSTEM_CA_BUNDLE_PATH = '/etc/ssl/certs/ca-certificates.crt'

/** Responses above this are rejected rather than buffered without bound. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export interface HttpsFetchDeps {
  /** Injected for tests; defaults to `node:https` `request`. */
  readonly request?: typeof httpsRequest
  /** Returns the extra CA bundle PEM, or `undefined` when unavailable. Read once. */
  readonly readCaBundle?: () => string | undefined
}

/** Best-effort read of the system CA bundle: an unreadable/missing file just means
 * Node's bundled roots alone. */
export function readSystemCaBundle(): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    return readFileSync(SYSTEM_CA_BUNDLE_PATH, 'utf8')
  } catch {
    return undefined
  }
}

export function createHttpsFetch(deps: HttpsFetchDeps = {}): JiraFetch {
  const request = deps.request ?? httpsRequest
  const readCaBundle = deps.readCaBundle ?? readSystemCaBundle
  // Built lazily on first call, so app startup never reads the bundle.
  let agent: Agent | undefined

  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      if (init.signal.aborted) {
        reject(init.signal.reason)
        return
      }
      if (agent === undefined) {
        const bundle = readCaBundle()
        agent = new Agent({
          keepAlive: true,
          ca: bundle === undefined ? [...rootCertificates] : [...rootCertificates, bundle]
        })
      }
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
    })
}
