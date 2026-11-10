import { describe, it, expect } from 'vitest'
import {
  CONTROL_METHODS,
  CONTROL_PROTOCOL_VERSION,
  ControlErrorCode,
  controlError,
  checkSessionName,
  MAX_SESSION_NAME_CHARS,
  parseControlRequest
} from './control-protocol'

const line = (o: unknown): string => JSON.stringify(o)
const base = { id: 'r1', version: CONTROL_PROTOCOL_VERSION }

function parseOk(o: unknown) {
  const r = parseControlRequest(line(o))
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.request
}

function parseErr(s: string) {
  const r = parseControlRequest(s)
  if (r.ok) throw new Error('expected failure')
  return r
}

describe('parseControlRequest envelope', () => {
  it('accepts a valid request and defaults missing params to {}', () => {
    const req = parseOk({ ...base, method: 'projects.list' })
    expect(req).toEqual({ id: 'r1', version: 1, method: 'projects.list', params: {} })
  })

  it('rejects malformed JSON as bad_json with an empty id', () => {
    const r = parseErr('{not json')
    expect(r.error.code).toBe(ControlErrorCode.BadJson)
    expect(r.id).toBe('')
  })

  it.each([['null'], ['[]'], ['"str"'], ['42']])('rejects non-object JSON %s', (s) => {
    expect(parseErr(s).error.code).toBe(ControlErrorCode.BadRequest)
  })

  it.each([
    [{ version: 1, method: 'projects.list' }],
    [{ id: '', version: 1, method: 'x' }],
    [{ id: 5 }]
  ])('rejects a missing/empty/non-string id %j', (o) => {
    const r = parseErr(line(o))
    expect(r.error.code).toBe(ControlErrorCode.BadRequest)
    expect(r.id).toBe('')
  })

  it('rejects a non-integer version with the recovered id', () => {
    for (const version of ['1', 1.5, undefined]) {
      const r = parseErr(line({ id: 'r9', version, method: 'projects.list' }))
      expect(r.error.code).toBe(ControlErrorCode.BadRequest)
      expect(r.id).toBe('r9')
    }
  })

  it('reports version_mismatch for another protocol version', () => {
    const r = parseErr(line({ id: 'r2', version: 99, method: 'projects.list' }))
    expect(r.error.code).toBe(ControlErrorCode.VersionMismatch)
    expect(r.error.message).toContain('99')
    expect(r.id).toBe('r2')
  })

  it('rejects a non-string method as bad_request and an unknown one as unknown_method', () => {
    expect(parseErr(line({ ...base, method: 7 })).error.code).toBe(ControlErrorCode.BadRequest)
    const r = parseErr(line({ ...base, method: 'nope.nothing' }))
    expect(r.error.code).toBe(ControlErrorCode.UnknownMethod)
    expect(r.error.message).toContain('nope.nothing')
  })

  it('rejects non-object params', () => {
    for (const params of [[], 'x', 3, null]) {
      const r = parseErr(line({ ...base, method: 'projects.list', params }))
      expect(r.error.code).toBe(ControlErrorCode.BadRequest)
    }
  })

  it('knows every method', () => {
    expect([...CONTROL_METHODS].sort()).toEqual(
      [
        'issues.add',
        'issues.get',
        'issues.list',
        'projects.list',
        'session.open',
        'task.create',
        'task.list'
      ].sort()
    )
  })
})

describe('parseControlRequest params', () => {
  const bad = (method: string, params: unknown): string => {
    const r = parseErr(line({ ...base, method, params }))
    expect(r.error.code).toBe(ControlErrorCode.BadRequest)
    return r.error.message
  }

  it('task.create requires project and branch strings', () => {
    expect(bad('task.create', {})).toContain('missing "project"')
    expect(bad('task.create', { project: 'p' })).toContain('missing "branch"')
    expect(bad('task.create', { project: 'p', branch: 3 })).toContain('"branch" must be a string')
    parseOk({ ...base, method: 'task.create', params: { project: 'p', branch: 'b' } })
  })

  it('task.create rejects empty required, name and sourceBranch', () => {
    expect(bad('task.create', { project: '', branch: 'b' })).toContain('must not be empty')
    expect(bad('task.create', { project: 'p', branch: '' })).toContain('must not be empty')
    expect(bad('task.create', { project: 'p', branch: 'b', name: '' })).toContain(
      '"name" must not be empty'
    )
    expect(bad('task.create', { project: 'p', branch: 'b', sourceBranch: '' })).toContain(
      '"sourceBranch" must not be empty'
    )
  })

  it('session.open requires taskId; an empty command (rejected later by the handler) and empty description parse', () => {
    expect(bad('session.open', {})).toContain('missing "taskId"')
    parseOk({ ...base, method: 'session.open', params: { taskId: 't', command: '' } })
    parseOk({ ...base, method: 'issues.add', params: { name: 'n', description: '' } })
  })

  it('session.open name must be a string when present', () => {
    expect(bad('session.open', { taskId: 't', name: 3 })).toContain('"name" must be a string')
    parseOk({ ...base, method: 'session.open', params: { taskId: 't', name: 'tab' } })
  })

  it('issues.add requires name and description', () => {
    expect(bad('issues.add', { description: 'd' })).toContain('missing "name"')
    expect(bad('issues.add', { name: 'n' })).toContain('missing "description"')
  })

  it('validates status on issues.list and issues.add', () => {
    expect(bad('issues.list', { status: 'wip' })).toContain('must be one of')
    expect(bad('issues.add', { name: 'n', description: 'd', status: 'x' })).toContain(
      'must be one of'
    )
    for (const status of ['todo', 'in_progress', 'blocked', 'in_review', 'done']) {
      parseOk({ ...base, method: 'issues.list', params: { status } })
    }
  })

  it('issues.get requires a non-empty issueId', () => {
    expect(bad('issues.get', {})).toContain('missing "issueId"')
    expect(bad('issues.get', { issueId: '' })).toContain('must not be empty')
  })

  it('rejects an unknown param, naming it, so an older app fails loudly', () => {
    expect(bad('task.list', { project: 'p', extra: 1 })).toContain('unknown param "extra"')
    expect(bad('projects.list', { x: 'y' })).toContain('unknown param "x"')
    expect(bad('session.open', { taskId: 't', prompt: 'p' })).toContain('unknown param "prompt"')
    // Prototype keys are not mistaken for known params.
    expect(bad('task.list', JSON.parse('{"toString":"x"}'))).toContain('unknown param "toString"')
  })
})

describe('controlError', () => {
  it('builds a failure reply', () => {
    expect(controlError('i', ControlErrorCode.NotFound, 'm')).toEqual({
      id: 'i',
      ok: false,
      error: { code: 'not_found', message: 'm' }
    })
  })
})

describe('checkSessionName', () => {
  it('accepts a short name, up to the limit in characters (not bytes)', () => {
    expect(checkSessionName('Fix rejects')).toBeUndefined()
    expect(checkSessionName('a'.repeat(MAX_SESSION_NAME_CHARS))).toBeUndefined()
    expect(checkSessionName('é'.repeat(MAX_SESSION_NAME_CHARS))).toBeUndefined()
    expect(checkSessionName('\u{1F419}'.repeat(MAX_SESSION_NAME_CHARS))).toBeUndefined()
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'a'.repeat(MAX_SESSION_NAME_CHARS + 1)],
    ['a newline', 'a\nb'],
    ['a tab', 'a\tb'],
    ['an escape', 'a\u001b[31mb'],
    ['DEL', 'a\u007fb']
  ])('rejects %s', (_n, name) => {
    expect(checkSessionName(name)).toBeDefined()
  })
})
