import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlMethod,
  type ControlReply,
  type ControlRequest
} from '../shared/control-protocol'

export const EXIT_OK = 0
export const EXIT_COMMAND_ERROR = 1
export const EXIT_USAGE = 2
export const EXIT_NOT_RUNNING = 3

export interface CliOutcome {
  readonly exitCode: number
  /** Text for stdout (already newline-terminated) or ''. */
  readonly stdout: string
  /** Text for stderr (already newline-terminated) or ''. */
  readonly stderr: string
}

/** Transport-level failure (no reply obtained). */
export type TransportFailure =
  | { readonly kind: 'not_running'; readonly socketPath: string }
  | { readonly kind: 'closed' }
  | { readonly kind: 'io'; readonly message: string }

export const errorJson = (code: string, message: string): string =>
  JSON.stringify({ error: { code, message } }) + '\n'

/** Pure: server reply → outcome. Success prints `result` compactly. */
export function replyToOutcome(reply: ControlReply): CliOutcome {
  if (reply.ok) {
    return { exitCode: EXIT_OK, stdout: JSON.stringify(reply.result) + '\n', stderr: '' }
  }
  return {
    exitCode: EXIT_COMMAND_ERROR,
    stdout: '',
    stderr: errorJson(reply.error.code, reply.error.message)
  }
}

/** Pure: transport failure → outcome. */
export function failureToOutcome(f: TransportFailure): CliOutcome {
  switch (f.kind) {
    case 'not_running':
      return {
        exitCode: EXIT_NOT_RUNNING,
        stdout: '',
        stderr: errorJson(
          'not_running',
          `Octopus is not running (no listener on ${f.socketPath}). Start the Octopus app and retry.`
        )
      }
    case 'closed':
      return {
        exitCode: EXIT_COMMAND_ERROR,
        stdout: '',
        stderr: errorJson(
          'connection_closed',
          'Octopus closed the connection before replying (the app may have quit); the command may not have completed.'
        )
      }
    case 'io':
      return {
        exitCode: EXIT_COMMAND_ERROR,
        stdout: '',
        stderr: errorJson('io_error', f.message)
      }
  }
}

/** Pure: usage error → outcome. */
export function usageToOutcome(message: string): CliOutcome {
  return { exitCode: EXIT_USAGE, stdout: '', stderr: message.replace(/\n*$/, '\n') }
}

/** Pure: build one request envelope. */
export function buildRequest(
  method: ControlMethod,
  params: Record<string, unknown>,
  id: string = randomUUID()
): ControlRequest {
  return { id, version: CONTROL_PROTOCOL_VERSION, method, params } as ControlRequest
}

/** Pure: parse a reply line; undefined if malformed or the id does not match. */
export function parseReplyLine(line: string, id: string): ControlReply | undefined {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>
    if (
      raw === null ||
      typeof raw !== 'object' ||
      (raw.id !== id && !(raw.id === '' && raw.ok === false))
    )
      return undefined
    if (raw.ok === true && 'result' in raw) return raw as unknown as ControlReply
    if (raw.ok === false && typeof raw.error === 'object' && raw.error !== null) {
      return raw as unknown as ControlReply
    }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Send one request, read one reply line, close. No timeout: `task.create` provisions a
 * worktree and may legitimately take minutes.
 */
export function sendRequest(
  socketPath: string,
  request: ControlRequest
): Promise<{ reply: ControlReply } | { failure: TransportFailure }> {
  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const done = (r: { reply: ControlReply } | { failure: TransportFailure }): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(r)
    }
    const socket = createConnection(socketPath)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const reply = parseReplyLine(buf.slice(0, nl), request.id)
      done(
        reply !== undefined
          ? { reply }
          : { failure: { kind: 'io', message: 'malformed reply from Octopus' } }
      )
    })
    socket.on('close', () => done({ failure: { kind: 'closed' } }))
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        done({ failure: { kind: 'not_running', socketPath } })
      } else if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        done({ failure: { kind: 'closed' } })
      } else {
        done({ failure: { kind: 'io', message: err.message } })
      }
    })
  })
}
