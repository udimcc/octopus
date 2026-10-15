import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LiteLLMJiraSource,
  parseSearchText,
  parseProjectsText,
  parseIssueDetailsText,
  type JiraFetch
} from './litellm-jira-source'
import { JiraSourceError } from '../../ports/jira-issue-source'

const FIXTURES_DIR = join(__dirname, '../../../test/fixtures/jira')

function fixtureEnvelope(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'))
}

function fixtureText(name: string): string {
  const envelope = fixtureEnvelope(name) as { content: Array<{ text: string }> }
  return envelope.content[0].text
}

/** One recorded fetch call: the parsed request body and the headers sent. */
interface RecordedCall {
  readonly url: string
  readonly body: { name: string; arguments: Record<string, unknown>; server_id: string }
  readonly headers: Readonly<Record<string, string>>
}

/** A fake `JiraFetch` that serves one `Response` per call, in order (the last one
 * repeats if more calls happen than responses were queued), and records every call's
 * url/parsed-body/headers so tests can assert on the request shape. */
function queueFetch(responses: readonly Response[]): { fetch: JiraFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let i = 0
  const fetch: JiraFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers })
    const response = responses[Math.min(i, responses.length - 1)]
    i++
    return response
  }
  return { fetch, calls }
}

function jsonResponse(envelope: unknown, status = 200): Response {
  return new Response(JSON.stringify(envelope), { status })
}

function textEnvelope(text: string, isError = false): unknown {
  return {
    _meta: null,
    content: [{ type: 'text', text, annotations: null, _meta: null }],
    structuredContent: null,
    isError
  }
}

const SERVER_ID = 'test-server-id'
const BASE_URL = 'https://litellm.test'

function makeSource(
  fetch: JiraFetch,
  overrides: { getApiKey?: () => Promise<string | undefined> } = {}
): LiteLLMJiraSource {
  return new LiteLLMJiraSource({
    fetch,
    getApiKey: overrides.getApiKey ?? (async () => 'secret-key-123'),
    baseUrl: BASE_URL,
    serverId: SERVER_ID
  })
}

describe('LiteLLMJiraSource — request shape', () => {
  it('POSTs to {baseUrl}/mcp-rest/tools/call with the alias-prefixed tool name, arguments and server_id', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('projects.json'))])
    const source = makeSource(fetch)

    await source.listProjects()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE_URL}/mcp-rest/tools/call`)
    expect(calls[0].body).toEqual({
      name: 'jira_jira_get_all_projects',
      arguments: {},
      server_id: SERVER_ID
    })
  })

  it('sends the Authorization bearer header (trimmed) and JSON content-type', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('projects.json'))])
    const source = makeSource(fetch, { getApiKey: async () => '  secret-key-123  ' })

    await source.listProjects()

    expect(calls[0].headers['Authorization']).toBe('Bearer secret-key-123')
    expect(calls[0].headers['Content-Type']).toBe('application/json')
  })
})

describe('LiteLLMJiraSource — API key handling', () => {
  it('throws noKey without calling fetch when getApiKey resolves undefined', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('projects.json'))])
    const source = makeSource(fetch, { getApiKey: async () => undefined })

    await expect(source.listProjects()).rejects.toMatchObject({
      kind: 'noKey',
      message: 'no Jira API key is configured'
    })
    expect(calls).toHaveLength(0)
  })

  it('throws noKey without calling fetch when the key is empty/whitespace-only', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('projects.json'))])
    const source = makeSource(fetch, { getApiKey: async () => '   ' })

    await expect(source.listProjects()).rejects.toMatchObject({ kind: 'noKey' })
    expect(calls).toHaveLength(0)
  })

  it('throws noKey without leaking the underlying error message when getApiKey rejects (M1)', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('projects.json'))])
    const source = makeSource(fetch, {
      getApiKey: async () => {
        throw new Error('ENOENT: /secret/path/credentials/jira.enc could not be read')
      }
    })

    const error = await source.listProjects().catch((e) => e as JiraSourceError)
    expect(error).toBeInstanceOf(JiraSourceError)
    expect((error as JiraSourceError).kind).toBe('noKey')
    expect((error as JiraSourceError).message).not.toContain('/secret/path')
    expect((error as JiraSourceError).message).toContain('could not be decrypted')
    expect(calls).toHaveLength(0)
  })

  it('throws noKey when the key contains non-printable-ASCII characters (I1)', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('projects.json'))])
    const source = makeSource(fetch, { getApiKey: async () => 'key-with-a-\n-newline' })

    await expect(source.listProjects()).rejects.toMatchObject({
      kind: 'noKey',
      message: 'the stored Jira API key contains invalid characters; re-enter it in Settings'
    })
    expect(calls).toHaveLength(0)
  })
})

describe('LiteLLMJiraSource — listProjects (parses test/fixtures/jira/projects.json)', () => {
  it('parses the "Found N projects" bullets into {key, ticketCount}', async () => {
    const { fetch } = queueFetch([jsonResponse(fixtureEnvelope('projects.json'))])
    const source = makeSource(fetch)

    const projects = await source.listProjects()

    expect(projects.length).toBeGreaterThan(0)
    expect(projects).toContainEqual({ key: 'TM', ticketCount: 820 })
    expect(projects).toContainEqual({ key: 'BUZZ', ticketCount: 878 })
  })
})

describe('LiteLLMJiraSource — getIssues (parses test/fixtures/jira/get-issue-batch.json)', () => {
  it('maps every field of a fetched issue, including dod, sprints and the Project key', async () => {
    const { fetch } = queueFetch([jsonResponse(fixtureEnvelope('get-issue-batch.json'))])
    const source = makeSource(fetch)

    const issues = await source.getIssues(['TM-2608'])

    expect(issues).toHaveLength(1)
    const issue = issues[0]
    expect(issue.key).toBe('TM-2608')
    expect(issue.summary).toBe('Broken CI - creds doesnt getting through')
    expect(issue.status).toBe('In Progress')
    expect(issue.priority).toBe('Low')
    expect(issue.type).toBe('Task')
    expect(issue.assignee).toBe('Alice Example')
    expect(issue.reporter).toBe('Alice Example')
    expect(issue.projectKey).toBe('TM')
    expect(issue.dodMarkdown).toContain('CI passes')
    expect(issue.descriptionMarkdown).toContain('OPENSTACK_USERNAME')
    // TM-2608 has a closed+active two-element Sprint array in the fixture.
    expect(issue.sprints.map((s) => s.state).sort()).toEqual(['active', 'closed'])
  })

  it('maps a null Sprint field to an empty sprints array (TM-2614)', async () => {
    const { fetch } = queueFetch([jsonResponse(fixtureEnvelope('get-issue-batch.json'))])
    const source = makeSource(fetch)

    const [issue] = await source.getIssues(['TM-2614'])

    expect(issue.sprints).toEqual([])
  })

  it('maps a null dod field to an empty dodMarkdown string (HD-10966)', async () => {
    const { fetch } = queueFetch([jsonResponse(fixtureEnvelope('get-issue-sprints.json'))])
    const source = makeSource(fetch)

    const [issue] = await source.getIssues(['HD-10966'])

    expect(issue.dodMarkdown).toBe('')
    expect(issue.sprints).toEqual([])
  })

  it('returns [] without calling fetch for an empty key list', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('get-issue-batch.json'))])
    const source = makeSource(fetch)

    const issues = await source.getIssues([])

    expect(issues).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('dedupes keys before requesting, so a repeated key is fetched once', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('get-issue-batch.json'))])
    const source = makeSource(fetch)

    await source.getIssues(['TM-2608', 'TM-2608', 'TM-2616'])

    expect(calls).toHaveLength(1)
    expect(calls[0].body.arguments.ticket_id).toBe('TM-2608,TM-2616')
  })

  it('batches more than 10 keys into groups of 10, comma-joined, in order', async () => {
    const { fetch, calls } = queueFetch([
      jsonResponse(textEnvelope('')),
      jsonResponse(textEnvelope(''))
    ])
    const source = makeSource(fetch)
    const keys = Array.from({ length: 15 }, (_, i) => `TM-${1000 + i}`)

    await source.getIssues(keys)

    expect(calls).toHaveLength(2)
    expect(calls[0].body.arguments.ticket_id).toBe(keys.slice(0, 10).join(','))
    expect(calls[1].body.arguments.ticket_id).toBe(keys.slice(10, 15).join(','))
  })

  it('silently drops keys the gateway could not find, never failing the whole batch', async () => {
    // The batch fixture only has 5 issues; asking for a 6th unknown key must not throw.
    const { fetch } = queueFetch([jsonResponse(fixtureEnvelope('get-issue-batch.json'))])
    const source = makeSource(fetch)

    const issues = await source.getIssues(['TM-2608', 'TM-9999-NOT-FOUND'])

    expect(issues.map((i) => i.key)).toEqual(['TM-2608'])
  })

  it('throws a gateway error for a real isError:true envelope (test/fixtures/jira/is-error.json)', async () => {
    const { fetch } = queueFetch([jsonResponse(fixtureEnvelope('is-error.json'))])
    const source = makeSource(fetch)

    const error = await source.getIssues(['TM-1']).catch((e) => e as JiraSourceError)
    expect(error).toBeInstanceOf(JiraSourceError)
    expect((error as JiraSourceError).kind).toBe('gateway')
    expect((error as JiraSourceError).message).toContain("'ticket_id' is a required property")
  })
})

describe('LiteLLMJiraSource — search', () => {
  it('an issueKey filter bypasses pagination and calls getIssues directly with just that key', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('get-issue-batch.json'))])
    const source = makeSource(fetch)

    const page = await source.search({ issueKey: 'TM-2608' })

    expect(calls).toHaveLength(1)
    expect(calls[0].body.name).toBe('jira_jira_get_issue')
    expect(calls[0].body.arguments.ticket_id).toBe('TM-2608')
    expect(page.issues.map((i) => i.key)).toEqual(['TM-2608'])
    expect(page.total).toBe(1)
    expect(page.nextCursor).toBeUndefined()
  })

  it('with no cursor, requests offset 0 and parses the search + issue fixtures into a page', async () => {
    const { fetch, calls } = queueFetch([
      jsonResponse(fixtureEnvelope('search-page1.json')),
      jsonResponse(fixtureEnvelope('get-issue-batch.json'))
    ])
    const source = makeSource(fetch)

    const page = await source.search({ project: 'TM' })

    expect(calls[0].body.name).toBe('jira_jira_search')
    expect(calls[0].body.arguments).toEqual({ limit: 50, offset: 0, project: 'TM' })
    expect(page.total).toBe(820)
    // search-page1.json's bullets are TM-2617/2616/2614/2613/2612; the get-issue-batch
    // fixture only has TM-2608/2616/2614/2611/2609 — getIssues silently drops the keys
    // the batch fixture doesn't cover, leaving just the intersection, in bullet order.
    expect(page.issues.map((i) => i.key)).toEqual(['TM-2616', 'TM-2614'])
    // offset(0) + keys returned by jira_search(5) = 5, which is < total(820), so paging continues.
    expect(page.nextCursor).toBe('5')
  })

  it('passes a numeric cursor through as the next offset', async () => {
    const { fetch, calls } = queueFetch([
      jsonResponse(fixtureEnvelope('search-page2.json')),
      jsonResponse(fixtureEnvelope('get-issue-batch.json'))
    ])
    const source = makeSource(fetch)

    await source.search({ project: 'TM' }, '5')

    expect(calls[0].body.arguments).toEqual({ limit: 50, offset: 5, project: 'TM' })
  })

  it('rejects a malformed cursor before ever calling fetch', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('search-page1.json'))])
    const source = makeSource(fetch)

    const error = await source
      .search({ project: 'TM' }, 'not-a-number')
      .catch((e) => e as JiraSourceError)
    expect(error).toBeInstanceOf(JiraSourceError)
    expect((error as JiraSourceError).kind).toBe('gateway')
    expect(calls).toHaveLength(0)
  })

  it('rejects a negative cursor before ever calling fetch', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('search-page1.json'))])
    const source = makeSource(fetch)

    await expect(source.search({ project: 'TM' }, '-1')).rejects.toMatchObject({ kind: 'gateway' })
    expect(calls).toHaveLength(0)
  })

  it('an unknown-project "No issues found" response yields an empty page with no getIssues call', async () => {
    const { fetch, calls } = queueFetch([jsonResponse(fixtureEnvelope('search-no-issues.json'))])
    const source = makeSource(fetch)

    const page = await source.search({ project: 'ZZZNOPE' })

    expect(page).toEqual({ issues: [], total: 0, nextCursor: undefined })
    expect(calls).toHaveLength(1)
  })

  it('ends pagination (no nextCursor) once offset + returned keys reaches the total (M6)', async () => {
    const smallSearch = textEnvelope(
      'Found 2 total issues in project ZZ (showing 1-2 of 2)\n\n' +
        '• [ZZ] ZZ-1 - First\n  Status: Done, Priority: Low, Type: Task\n  Assignee: Unassigned, Reporter: Unassigned\n  Created: 2026-01-01T00:00:00.000+0300\n\n' +
        '• [ZZ] ZZ-2 - Second\n  Status: Done, Priority: Low, Type: Task\n  Assignee: Unassigned, Reporter: Unassigned\n  Created: 2026-01-01T00:00:00.000+0300\n\n'
    )
    const { fetch } = queueFetch([
      jsonResponse(smallSearch),
      jsonResponse(
        textEnvelope(
          'Issue ZZ-1 details:\n{"Summary":"First"}\n---\nIssue ZZ-2 details:\n{"Summary":"Second"}\n---\n'
        )
      )
    ])
    const source = makeSource(fetch)

    const page = await source.search({ project: 'ZZ' })

    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeUndefined()
  })
})

describe('LiteLLMJiraSource — search with a sprint filter', () => {
  const sprintSearch = textEnvelope(
    'Found 3 total issues in project ZZ (showing 1-2 of 3)\n⚠️ 1 more tickets available. Use offset=2 to get the next batch.\n\n' +
      '• [ZZ] ZZ-1 - First\n  Status: Done, Priority: Low, Type: Task\n  Assignee: Unassigned, Reporter: Unassigned\n  Created: 2026-01-02T00:00:00.000+0300\n\n' +
      '• [ZZ] ZZ-2 - Second\n  Status: Done, Priority: Low, Type: Task\n  Assignee: Unassigned, Reporter: Unassigned\n  Created: 2026-01-01T00:00:00.000+0300\n\n'
  )
  const sprintSearchPage2 = textEnvelope(
    'Found 3 total issues in project ZZ (showing 3-3 of 3)\n\n' +
      '• [ZZ] ZZ-3 - Third\n  Status: Done, Priority: Low, Type: Task\n  Assignee: Unassigned, Reporter: Unassigned\n  Created: 2026-01-01T00:00:00.000+0300\n\n'
  )
  function issueDetails(entries: ReadonlyArray<{ key: string; sprintId: number }>): unknown {
    const blocks = entries
      .map(
        ({ key, sprintId }) =>
          `Issue ${key} details:\n${JSON.stringify({
            Summary: key,
            Sprint: [{ id: sprintId, name: `Sprint ${sprintId}`, state: 'active' }]
          })}\n---\n`
      )
      .join('')
    return textEnvelope(blocks)
  }

  it('scans pages, excluding issues outside the filtered sprint via matchesSprintFilter, and stops once the gateway runs out', async () => {
    const { fetch, calls } = queueFetch([
      jsonResponse(sprintSearch),
      // ZZ-1 matches sprint 42; ZZ-2 has full details but sits in a DIFFERENT
      // sprint (99) — it must be excluded by matchesSprintFilter, not merely
      // because its details were missing from the gateway response.
      jsonResponse(
        issueDetails([
          { key: 'ZZ-1', sprintId: 42 },
          { key: 'ZZ-2', sprintId: 99 }
        ])
      ),
      jsonResponse(sprintSearchPage2),
      jsonResponse(issueDetails([{ key: 'ZZ-3', sprintId: 42 }]))
    ])
    const source = makeSource(fetch)

    const page = await source.search({
      project: 'ZZ',
      sprint: { kind: 'id', id: 42, name: 'Sprint 42' }
    })

    expect(page.issues.map((i) => i.key)).toEqual(['ZZ-1', 'ZZ-3'])
    // Nit: the total reported is the FIRST page's total, never overwritten by a later page.
    expect(page.total).toBe(3)
    expect(page.nextCursor).toBeUndefined()
    // 2 search calls + 2 getIssues calls.
    expect(calls.filter((c) => c.body.name === 'jira_jira_search')).toHaveLength(2)
  })

  it('stops at the per-call page cap, reports a cursor, and resuming it yields no gaps or duplicates', async () => {
    // Total is far larger than one scan's page cap (MAX_SPRINT_FILTER_PAGES=10
    // pages * SEARCH_PAGE_LIMIT=50/page = 500 rows/call), so a single `search`
    // call must stop mid-dataset and hand back a cursor rather than scanning
    // forever. Exactly one key per 50-row page matches the sprint filter, so
    // the match count (10) never hits the 50-match cap first — this exercises
    // the PAGE cap specifically.
    const total = 1000
    const matchingSprintId = 7
    const calls: RecordedCall[] = []
    const fetch: JiraFetch = async (url, init) => {
      const body = JSON.parse(init.body) as RecordedCall['body']
      calls.push({ url, body, headers: init.headers })
      if (body.name === 'jira_jira_search') {
        const { offset, limit } = body.arguments as { offset: number; limit: number }
        const keys: string[] = []
        for (let i = offset; i < Math.min(offset + limit, total); i++) keys.push(`K${i}`)
        const text =
          keys.length === 0
            ? 'No issues found with filters: project=ZZ'
            : `Found ${total} total issues in project ZZ\n\n${keys
                .map((k) => `• [ZZ] ${k} - Issue ${k}`)
                .join('\n')}\n`
        return jsonResponse(textEnvelope(text))
      }
      if (body.name === 'jira_jira_get_issue') {
        const keys = (body.arguments.ticket_id as string).split(',')
        const blocks = keys
          .map((key) => {
            const i = Number(key.slice(1))
            const sprintId = i % 50 === 0 ? matchingSprintId : matchingSprintId + 1
            return `Issue ${key} details:\n${JSON.stringify({
              Summary: key,
              Sprint: [{ id: sprintId, name: `Sprint ${sprintId}`, state: 'active' }]
            })}\n---\n`
          })
          .join('')
        return jsonResponse(textEnvelope(blocks))
      }
      throw new Error(`unexpected tool ${body.name}`)
    }
    const source = makeSource(fetch)
    const filter = { kind: 'id' as const, id: matchingSprintId, name: `Sprint ${matchingSprintId}` }

    const page1 = await source.search({ project: 'ZZ', sprint: filter })
    expect(page1.nextCursor).toBeDefined()
    expect(page1.issues.map((i) => i.key)).toEqual([
      'K0',
      'K50',
      'K100',
      'K150',
      'K200',
      'K250',
      'K300',
      'K350',
      'K400',
      'K450'
    ])

    const page2 = await source.search({ project: 'ZZ', sprint: filter }, page1.nextCursor)
    expect(page2.nextCursor).toBeUndefined()
    expect(page2.issues.map((i) => i.key)).toEqual([
      'K500',
      'K550',
      'K600',
      'K650',
      'K700',
      'K750',
      'K800',
      'K850',
      'K900',
      'K950'
    ])

    const expectedMatches = Array.from({ length: total / 50 }, (_, i) => `K${i * 50}`)
    const union = [...page1.issues, ...page2.issues].map((i) => i.key)
    expect(union).toEqual(expectedMatches) // no gaps, no duplicates vs. the full expected match set
  })
})

describe('LiteLLMJiraSource — listSprints', () => {
  it('requests the 30 most recent issues with no "days" argument, then returns deduped+ordered sprints', async () => {
    // search-page2.json's keys (TM-2611/2610/2609/2608/2607) intersect get-issue-batch.json
    // (which has TM-2608/2616/2614/2611/2609) at TM-2608, TM-2611 and TM-2609 — TM-2608
    // alone contributes a closed + active sprint pair.
    const { fetch, calls } = queueFetch([
      jsonResponse(fixtureEnvelope('search-page2.json')),
      jsonResponse(fixtureEnvelope('get-issue-batch.json'))
    ])
    const source = makeSource(fetch)

    const sprints = await source.listSprints('TM')

    const searchCall = calls.find((c) => c.body.name === 'jira_jira_search')!
    expect(searchCall.body.arguments).toEqual({ limit: 30, offset: 0, project: 'TM' })
    expect(searchCall.body.arguments).not.toHaveProperty('days')
    // TM-2608 contributes a closed + active sprint; orderSprints puts active before closed.
    expect(sprints[0].state).toBe('active')
    expect(sprints.some((s) => s.state === 'closed')).toBe(true)
  })
})

describe('LiteLLMJiraSource — errors (never leak error.message, I1)', () => {
  it('maps HTTP 401 to kind "unauthorized"', async () => {
    const { fetch } = queueFetch([new Response('', { status: 401 })])
    const source = makeSource(fetch)

    await expect(source.listProjects()).rejects.toMatchObject({ kind: 'unauthorized' })
  })

  it('maps HTTP 403 to kind "unauthorized"', async () => {
    const { fetch } = queueFetch([new Response('', { status: 403 })])
    const source = makeSource(fetch)

    await expect(source.listProjects()).rejects.toMatchObject({ kind: 'unauthorized' })
  })

  it('maps a non-ok, non-401/403 status to kind "gateway", including the status and body', async () => {
    const { fetch } = queueFetch([new Response('internal error details', { status: 500 })])
    const source = makeSource(fetch)

    const error = await source.listProjects().catch((e) => e as JiraSourceError)
    expect((error as JiraSourceError).kind).toBe('gateway')
    expect((error as JiraSourceError).message).toContain('500')
    expect((error as JiraSourceError).message).toContain('internal error details')
  })

  it('maps isError:true to kind "gateway", including the tool error text', async () => {
    const { fetch } = queueFetch([jsonResponse(textEnvelope('boom: bad input', true))])
    const source = makeSource(fetch)

    const error = await source.listProjects().catch((e) => e as JiraSourceError)
    expect((error as JiraSourceError).kind).toBe('gateway')
    expect((error as JiraSourceError).message).toContain('boom: bad input')
  })

  it('maps an envelope missing "content" to kind "gateway"', async () => {
    const { fetch } = queueFetch([jsonResponse({ isError: false })])
    const source = makeSource(fetch)

    await expect(source.listProjects()).rejects.toMatchObject({ kind: 'gateway' })
  })

  it('maps a non-object envelope (e.g. a bare array) to kind "gateway"', async () => {
    const { fetch } = queueFetch([jsonResponse([])])
    const source = makeSource(fetch)

    await expect(source.listProjects()).rejects.toMatchObject({ kind: 'gateway' })
  })

  it('maps an unparseable JSON response body to kind "gateway" without re-throwing the SyntaxError', async () => {
    const { fetch } = queueFetch([new Response('not valid json {{{', { status: 200 })])
    const source = makeSource(fetch)

    const error = await source.listProjects().catch((e) => e as JiraSourceError)
    expect((error as JiraSourceError).kind).toBe('gateway')
    expect((error as JiraSourceError).message).toContain('malformed response body')
  })

  it('maps a thrown network error to kind "unreachable", describing it by name+code, never error.message', async () => {
    const fetch: JiraFetch = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443', { cause: { code: 'ECONNREFUSED' } })
    }
    const source = makeSource(fetch)

    const error = await source.listProjects().catch((e) => e as JiraSourceError)
    expect((error as JiraSourceError).kind).toBe('unreachable')
    expect((error as JiraSourceError).message).toContain('ECONNREFUSED')
    expect((error as JiraSourceError).message).not.toContain('10.0.0.1')
  })

  it('maps a timeout (AbortSignal.timeout firing) to kind "unreachable" with a clear message', async () => {
    const fetch: JiraFetch = async () => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    }
    const source = makeSource(fetch)

    await expect(source.listProjects()).rejects.toMatchObject({
      kind: 'unreachable',
      message: 'Jira gateway timed out'
    })
  })

  it('caps an overlong message at 300 characters with a trailing ellipsis', async () => {
    const longBody = 'x'.repeat(1000)
    const { fetch } = queueFetch([new Response(longBody, { status: 500 })])
    const source = makeSource(fetch)

    const error = await source.listProjects().catch((e) => e as JiraSourceError)
    expect((error as JiraSourceError).message.length).toBeLessThanOrEqual(301)
    expect((error as JiraSourceError).message.endsWith('…')).toBe(true)
  })
})

describe('parseSearchText / parseProjectsText / parseIssueDetailsText (pure, exported for fixture-targeted tests)', () => {
  it('parseSearchText treats "No issues found..." as an empty page, not an error', () => {
    expect(parseSearchText(fixtureText('search-no-issues.json'))).toEqual({ total: 0, keys: [] })
  })

  it('parseSearchText throws a gateway error for text matching neither the header nor "No issues found"', () => {
    expect(() => parseSearchText('garbage, not a real response')).toThrow(JiraSourceError)
  })

  it('parseProjectsText parses every "• KEY: N tickets" bullet from the real fixture', () => {
    const projects = parseProjectsText(fixtureText('projects.json'))
    expect(projects.length).toBeGreaterThan(50)
    expect(projects[0]).toEqual({ key: 'PI', ticketCount: 5571 })
  })

  it('parseIssueDetailsText skips a block whose JSON body fails to parse, without throwing', () => {
    const issues = parseIssueDetailsText('Issue AB-1 details:\n{not valid json\n---\n')
    expect(issues).toEqual([])
  })

  it('parseIssueDetailsText parses all 5 issues out of the real batch fixture, in order', () => {
    const issues = parseIssueDetailsText(fixtureText('get-issue-batch.json'))
    expect(issues.map((i) => i.key)).toEqual([
      'TM-2608',
      'TM-2616',
      'TM-2614',
      'TM-2611',
      'TM-2609'
    ])
  })
})
