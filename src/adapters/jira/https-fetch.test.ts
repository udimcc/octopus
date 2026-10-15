import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHttpsFetch, type HttpsFetchDeps } from './https-fetch'
import type { request as httpsRequest } from 'node:https'

/** A minimal fake `node:https` `ClientRequest`/response pair, driven manually by each test. */
class FakeClientRequest extends EventEmitter {
  public ended = false
  public destroyed: unknown
  end(): this {
    this.ended = true
    return this
  }
  destroy(reason?: unknown): this {
    this.destroyed = reason
    // Mirror real https.ClientRequest: destroying mid-flight surfaces an error.
    this.emit('error', reason instanceof Error ? reason : new Error(String(reason)))
    return this
  }
}

class FakeIncomingMessage extends EventEmitter {
  statusCode = 200
  headers: Record<string, string | string[]> = {}
}

function init(body = '{}'): {
  method: 'POST'
  headers: Readonly<Record<string, string>>
  body: string
  signal: AbortSignal
} {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: new AbortController().signal
  }
}

describe('createHttpsFetch (DESIGN §13.7)', () => {
  it('resolves a Response with the status, headers and buffered body on a trusted connection', async () => {
    const req = new FakeClientRequest()
    const requestFn = vi.fn(() => req) as unknown as typeof httpsRequest
    const fetch = createHttpsFetch({ request: requestFn, readCaBundle: () => undefined })

    const promise = fetch('https://example.invalid/path', init('{"a":1}'))

    const res = new FakeIncomingMessage()
    res.statusCode = 200
    res.headers = { 'content-type': 'application/json' }
    req.emit('response', res)
    res.emit('data', Buffer.from('{"ok":true}'))
    res.emit('end')

    const response = await promise
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('rejects with the underlying error, keeping its `code`, on a TLS/socket failure', async () => {
    const req = new FakeClientRequest()
    const requestFn = vi.fn(() => req) as unknown as typeof httpsRequest
    const fetch = createHttpsFetch({ request: requestFn, readCaBundle: () => undefined })

    const promise = fetch('https://example.invalid/path', init())

    const tlsError = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    })
    req.emit('error', tlsError)

    await expect(promise).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
  })

  it('a signal that aborts mid-body-read rejects with the signal reason (TimeoutError-shaped)', async () => {
    const req = new FakeClientRequest()
    const requestFn = vi.fn(() => req) as unknown as typeof httpsRequest
    const fetch = createHttpsFetch({ request: requestFn, readCaBundle: () => undefined })
    const controller = new AbortController()

    const promise = fetch('https://example.invalid/path', {
      method: 'POST',
      headers: {},
      body: '{}',
      signal: controller.signal
    })

    const res = new FakeIncomingMessage()
    req.emit('response', res)
    res.emit('data', Buffer.from('partial'))

    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError')
    controller.abort(timeoutError)

    await expect(promise).rejects.toBe(timeoutError)
    expect(req.destroyed).toBe(timeoutError)
  })

  it('a pre-aborted signal rejects immediately without ever calling request()', async () => {
    const requestFn = vi.fn() as unknown as typeof httpsRequest
    const fetch = createHttpsFetch({ request: requestFn, readCaBundle: () => undefined })
    const controller = new AbortController()
    const reason = new DOMException('aborted', 'AbortError')
    controller.abort(reason)

    await expect(
      fetch('https://example.invalid/path', {
        method: 'POST',
        headers: {},
        body: '{}',
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(requestFn).not.toHaveBeenCalled()
  })

  it('readCaBundle is lazy: never called at construction, called exactly once across multiple fetches', async () => {
    const readCaBundle = vi.fn(() => undefined)
    const requests: FakeClientRequest[] = []
    const requestFn = vi.fn(() => {
      const req = new FakeClientRequest()
      requests.push(req)
      return req
    }) as unknown as typeof httpsRequest
    const deps: HttpsFetchDeps = { request: requestFn, readCaBundle }
    const fetch = createHttpsFetch(deps)

    expect(readCaBundle).not.toHaveBeenCalled()

    const settle = (): void => {
      const req = requests[requests.length - 1]
      const res = new FakeIncomingMessage()
      req.emit('response', res)
      res.emit('end')
    }

    const first = fetch('https://example.invalid/one', init())
    settle()
    await first
    expect(readCaBundle).toHaveBeenCalledTimes(1)

    const second = fetch('https://example.invalid/two', init())
    settle()
    await second
    expect(readCaBundle).toHaveBeenCalledTimes(1)
  })

  it('a 204 response resolves with a null body', async () => {
    const req = new FakeClientRequest()
    const requestFn = vi.fn(() => req) as unknown as typeof httpsRequest
    const fetch = createHttpsFetch({ request: requestFn, readCaBundle: () => undefined })

    const promise = fetch('https://example.invalid/path', init())
    const res = new FakeIncomingMessage()
    res.statusCode = 204
    req.emit('response', res)
    res.emit('end')

    const response = await promise
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })
})
