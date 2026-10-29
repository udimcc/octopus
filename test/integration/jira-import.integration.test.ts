/**
 * Jira import end to end (DESIGN "Jira import") over a REAL `CommandLoop`
 * wired on the `test-fakes.ts` fakes via `makeDeps()`, fetching through a
 * REAL `LiteLLMJiraSource` whose `fetch` is faked to serve the captured
 * gateway fixtures under `test/fixtures/jira/` — never the live gateway.
 *
 * Covers the full lifecycle: fetch → preview (all New) → import → simulated
 * restart (`Workspace.hydrate`) → re-preview (now Duplicate) → rename →
 * re-preview (now Conflict) → delete → re-preview (New again).
 */

import { describe, it, expect } from 'vitest'
import { CommandLoop } from '../../src/application/command-loop'
import { makeDeps, type FakeDeps } from '../../src/application/use-cases/test-fakes'
import { Workspace } from '../../src/domain/workspace'
import { previewJiraIssues } from '../../src/application/queries/preview-jira-issues'
import { LiteLLMJiraSource, type JiraFetch } from '../../src/adapters/jira/litellm-jira-source'
import type { AppDependencies } from '../../src/application/dependencies'
import getIssueBatchFixture from '../fixtures/jira/get-issue-batch.json'

/** A fresh rig: a real `CommandLoop` over a fresh set of fakes. */
function rig(): { loop: CommandLoop; fd: FakeDeps } {
  const fd = makeDeps()
  return { loop: new CommandLoop(fd.deps), fd }
}

/**
 * A fake `fetch` that never leaves the process: it inspects the gateway
 * request body and serves `get-issue-batch.json` verbatim for any
 * `jira_get_issue` call, regardless of the exact `ticket_id` requested
 * (the fixture's 5 issues — TM-2608, TM-2616, TM-2614, TM-2611, TM-2609 — are
 * what `getIssues` is asked for below, so the keys always line up).
 */
const fakeFetch: JiraFetch = async (_url, init) => {
  const body = JSON.parse(init.body) as { name: string }
  if (body.name === 'jira_get_issue') {
    return new Response(JSON.stringify(getIssueBatchFixture), { status: 200 })
  }
  throw new Error(`fakeFetch: unexpected tool ${body.name}`)
}

/** Reads straight from `fd.deps.workspace` — the real `previewJiraIssues` query,
 * never a hand-rolled classification. */
function preview(fd: FakeDeps, issues: Parameters<typeof previewJiraIssues>[1]) {
  return previewJiraIssues(fd.deps, issues)
}

describe('Jira import end to end over the real CommandLoop + LiteLLMJiraSource (DESIGN "Jira import")', () => {
  it('fetch → import → restart → edit → delete cycles a fetched issue through New → Duplicate → Conflict → New', async () => {
    const { loop, fd } = rig()
    const jiraSource = new LiteLLMJiraSource({
      fetch: fakeFetch,
      getApiKey: async () => 'test-key',
      baseUrl: 'https://litellm.israel.final',
      serverId: '628a8d3ece8c06bc50523679ea834304'
    })

    // 1. Fetch real JiraIssue domain objects through the adapter, parsed from
    // the fixture — never a hand-built JiraIssue literal.
    const fetched = await jiraSource.getIssues([
      'TM-2608',
      'TM-2616',
      'TM-2614',
      'TM-2611',
      'TM-2609'
    ])
    expect(fetched).toHaveLength(5)

    // 2. Preview against the empty workspace: every fetched issue is New.
    const firstPreview = preview(fd, fetched)
    expect(firstPreview).toHaveLength(5)
    for (const row of firstPreview) {
      expect(row.classification).toEqual({ kind: 'new' })
    }

    // 3. Import all 5 through the real command loop.
    const imported = await loop.dispatch({ kind: 'importJiraIssues', input: { issues: fetched } })
    expect(imported).toMatchObject({ ok: true, importedCount: 5, skippedKeys: [] })

    const target = fd.workspace.issues().find((i) => i.jiraKey === 'TM-2608')!
    expect(target).toBeDefined()
    const targetId = target.id

    // 4. Simulate an app restart: rebuild a fresh `Workspace` from exactly what
    // `FakePersistence` recorded, the same way `issues.integration.test.ts` does.
    const persisted = fd.persistence.load()
    const restored = Workspace.hydrate(
      {
        tasks: fd.workspace.toSnapshot(fd.deps.aggregator).tasks,
        activeTaskId: fd.workspace.activeTaskId,
        issues: persisted.issues
      },
      { defaultSessionTypeId: 'terminal' }
    )
    const restoredDeps = { workspace: restored } as unknown as AppDependencies

    // 5. Re-preview the SAME fetched Jira issues against the restored
    // workspace: every one is now a Duplicate of the issue just imported.
    const secondPreview = previewJiraIssues(restoredDeps, fetched)
    expect(secondPreview).toHaveLength(5)
    for (const row of secondPreview) {
      expect(row.classification.kind).toBe('duplicate')
    }

    // 6. Rename the imported TM-2608 issue (a local edit) through the real
    // command loop, then re-preview against the LIVE (not restored) workspace:
    // that one issue is now a Conflict, the rest stay Duplicate.
    const renamed = await loop.dispatch({
      kind: 'updateIssue',
      input: { issueId: targetId, name: 'Locally renamed' }
    })
    expect(renamed).toEqual({ ok: true })

    const thirdPreview = preview(fd, fetched)
    const tm2608Row = thirdPreview.find((row) => row.issue.key === 'TM-2608')!
    expect(tm2608Row.classification).toMatchObject({ kind: 'conflict', issueId: targetId })
    for (const row of thirdPreview.filter((r) => r.issue.key !== 'TM-2608')) {
      expect(row.classification.kind).toBe('duplicate')
    }

    // 7. Delete the (now-conflicting) local issue; TM-2608 classifies as New
    // again, since no Octopus issue carries its `jiraKey` anymore.
    const deleted = await loop.dispatch({ kind: 'deleteIssue', input: { issueId: targetId } })
    expect(deleted).toEqual({ ok: true })

    const fourthPreview = preview(fd, fetched)
    const tm2608Again = fourthPreview.find((row) => row.issue.key === 'TM-2608')!
    expect(tm2608Again.classification).toEqual({ kind: 'new' })
  })
})
