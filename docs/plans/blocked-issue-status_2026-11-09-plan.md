# Blocked Issue Status - Plan

**Feature**: Add an issue status `Blocked` (`'blocked'`) plus a free-text markdown "blocked reasons" field. The reasons are independent of status and never auto-cleared; they are edited and shown in IssueDetail only while the issue is Blocked. Design: `blocked-issue-status_2026-11-09-design.md`.

## Wave 1 (parallel)
### [x] Subject 1: Domain
**Files:** src/domain/issue.ts, src/domain/snapshots.ts

- [x] Add `IssueStatus.Blocked = 'blocked'` and a `'blocked'` case in `parseIssueStatus`
- [x] Add `_blockedReasons` (default `''`), a `blockedReasons` getter and `setBlockedReasons`; `setStatus` must never touch it
- [x] Add `blockedReasons: string` to `IssueSnapshot`; wire it through `fromSnapshot`/`toSnapshot`

### [x] Subject 2: Shared wire contract
**Files:** src/shared/dto.ts

- [x] `IssueStatusDTO` gains `'blocked'`; `IssueDTO.blockedReasons: string`; `UpdateIssueInput.blockedReasons?: string` (`CreateIssueInput` unchanged)

### [x] Subject 3: Docs
**Files:** PRD.md (Issues section), DESIGN.md (§13.1 + v12 note), CHANGELOG.md (new top section)

- [x] Document the Blocked status, its order and icon, and the blocked reasons rules (shown only when Blocked, kept across status changes, never auto-cleared, edited via Edit)
- [x] Document the schema v12 rebuild
- [x] Note that issue `'blocked'` is unrelated to the session-state wire value `NeedsInput = 'blocked'`

## Wave 2 (depends on Wave 1)
### [x] Subject 4: Persistence v12
**Files:** src/adapters/persistence/schema.ts, src/adapters/persistence/mappers.ts, src/adapters/persistence/sqlite-store.ts (comment only), scripts/probe-sqlite-store.cjs

- [x] Fresh `issues` DDL: status CHECK admits `'blocked'`; add `blocked_reasons TEXT NOT NULL DEFAULT ''` (v8/v9 migration DDL untouched — append-only)
- [x] v12 `Migration` guarded by `unlessColumnExists: { table: 'issues', column: 'blocked_reasons' }`: create `issues_v12` (full current shape incl. source/jira_key CHECKs and `task_id UNIQUE REFERENCES tasks ON DELETE SET NULL`), copy all columns, drop `issues`, rename; comment that nothing references `issues` by FK; `SCHEMA_VERSION = 12`
- [x] Update the `idx_issues_jira_key` re-creation comment in `SqliteStore.create` to mention v12
- [x] mappers.ts: `blocked_reasons` in the row type, snapshot→row, row→snapshot and the upsert column list
- [x] Probe script: bump `CURRENT_SCHEMA_VERSION` (currently stale at 10) to 12 and add a v11 fixture DB

### [x] Subject 5: Application
**Files:** src/application/commands.ts, src/application/use-cases/update-issue.ts

- [x] commands.ts: `blockedReasons?: string` on the update-issue input
- [x] update-issue.ts: apply the optional patch; include it in the prior capture and the rollback; update the header doc

### [x] Subject 6: Renderer status table and icon
**Files:** src/renderer/src/store/issue-status.ts, src/renderer/src/components/IssueStatusIcon.tsx

- [x] Order `todo, in_progress, blocked, in_review, done`; label `blocked: 'Blocked'`; update doc comments ("4-value" → 5)
- [x] `blocked` glyph: red no-entry circle (circle + horizontal bar) in `color.errorText`, in both the shape and color tables

## Wave 3 (depends on Wave 2)
### [x] Subject 7: Main process
**Files:** src/main/ipc-handlers.ts, src/main/dto-mappers.ts

- [x] `issues.update` handler: reject a present-but-non-string `blockedReasons` (`'Invalid issue blocked reasons'`); pass it to the `updateIssue` dispatch
- [x] dto-mappers.ts: map `blockedReasons` onto `IssueDTO`

### [x] Subject 8: IssueDetail and derived views
**Files:** src/renderer/src/components/IssueDetail.tsx (verify-only: KanbanBoard.tsx, IssueList.tsx, IssuePicker.tsx, NewTaskModal.tsx, store/group-issues.ts)

- [x] Add `blockedReasons` to form state, `computeDirty`, `startEdit` and `saveEdit` (always sent on Save)
- [x] Edit mode: textarea right after Description, shown live only while the issue's current status is `'blocked'`; a status change mid-edit keeps the hidden draft, which still counts as dirty
- [x] View mode (only when Blocked): below the description, a divider + "Blocked reasons" heading + `IssueMarkdown`, or a muted "No reason given" when empty
- [x] Draft (new-issue) form: no field
- [x] Verify Board columns, List groups and pickers derive from `ISSUE_STATUS_ORDER` and the Board lays out 5 columns; update group-issues.ts doc comment

## Testing

- [x] Update 4-status enumerations in issue.test.ts, IssueStatusIcon.test.tsx, IssueList.test.tsx, group-issues.test.ts, KanbanBoard.test.tsx, mappers.test.ts, dto-mappers.test.ts, sqlite-store.test.ts
- [x] Domain: `parseIssueStatus('blocked')`; snapshot round-trip with reasons; `setStatus` away from Blocked keeps reasons
- [x] sqlite-store.test.ts (FakeDb): v11 DB runs the v12 rebuild and stamps 12; fresh, already-v12 and v7 (pre-Issues) DBs skip it via the guard; jira_key index re-created after migrations; fresh DDL and v12 DDL carry the same CHECK and column
- [x] Real binary (`npm run probe:sqlite`): a v11 DB with rows in every status, a task-bound issue and a Jira issue migrates to v12 with all fields kept and reasons `''`; UNIQUE jira_key, source/jira_key CHECK and `ON DELETE SET NULL` still hold; `'blocked'` accepted, unknown status rejected
- [x] update-issue.test.ts: reasons patch; rollback restores reasons on persist failure; status-only patch leaves reasons
- [x] ipc-handlers.test.ts: non-string `blockedReasons` rejected; `status: 'blocked'` accepted
- [x] IssueDetail.test.tsx: view Blocked with reasons / Blocked empty (placeholder) / not Blocked (hidden); edit field shows/hides on mid-edit status change; hidden draft is dirty; Save sends `blockedReasons`; Cancel restores; draft form has no field
- [x] KanbanBoard.test.tsx: Blocked column exists; dropping a card on it dispatches `status: 'blocked'`
- [x] import-jira-issues.test.ts / jira-import.test.ts: re-import of a Jira issue with Blocked status and reasons still classifies Unchanged
- [x] test/integration/issues.integration.test.ts: Blocked + reasons round-trip through the CommandLoop
- [x] Edge case: whitespace-only reasons stored as given
- [x] `npm run typecheck`, `npm run lint`, `npm run test` all green

## Acceptance Criteria
- Users can set an issue to Blocked from the status dropdown and the Board; it appears between In progress and In review with a red no-entry icon
- Blocked reasons are editable (via Edit) and visible only while Blocked, render as markdown, and survive status changes and restarts
- Existing v11 databases upgrade to v12 without data loss (backup first); constraints and the jira_key index intact; older builds refuse the v12 DB
- No layer-boundary violations; IPC rejects bad input; all existing and new tests pass
