# Jira Issue Import - Plan

**Feature**: Manual, read-only import of Jira issues (via the LiteLLM MCP gateway) into Octopus Issues. A filterable preview modal in the Issues drawer classifies each fetched issue as New, Duplicate or Conflict by `jiraKey`, and imports the selected rows as `source='jira'` issues. The Jira API key is stored encrypted with safeStorage.

> **Verification note.** Two things mean whole-tree `npm run typecheck` will fail between waves:
> - Exhaustive switches: `CommandLoop.handle` in `src/application/command-loop.ts`, `reduceEvent` in `src/renderer/src/store/store.ts`, and `toEventDTO` in `src/main/dto-mappers.ts`.
> - `source` is now required on `IssueSnapshot` and `IssueDTO`.
>
> Through Waves 1–4, each subject checks itself with `npx vitest run <its files>`. The full gate runs in Wave 5.

## Wave 1 (parallel)

### [x] Subject 1: Domain — Issue source and pure Jira import rules
- [x] `src/domain/issue.ts`: add an `IssueSource` enum (`Local='local'`, `Jira='jira'`) and `parseIssueSource(value)`, modeled on `parseIssueStatus`.
- [x] `src/domain/issue.ts`: add optional `source` (default `Local`) and `jiraKey` to `IssueCreateProps`.
  - Add read-only `source`/`jiraKey` getters, with no setters.
  - Throw `InvariantViolationError` when `jiraKey` is set without `source=Jira`, or when `source=Jira` has no `jiraKey`.
  - Carry both fields through `fromSnapshot` and `toSnapshot`.
- [x] `src/domain/snapshots.ts`: add a required `source: IssueSource` and an optional `jiraKey?: string` to `IssueSnapshot`.
- [x] NEW `src/domain/jira-import.ts`: plain value types.
  - `JiraIssue`: key, summary, descriptionMarkdown, dodMarkdown, status, priority, type, assignee?, reporter?, created, projectKey, `sprints: JiraSprint[]`.
  - `JiraSprint`: id, name, state (`'active'|'future'|'closed'`).
  - `JiraProject`: key, ticketCount.
  - `JiraClassification`.
- [x] `src/domain/jira-import.ts`: `composeJiraIssue(issue) → {name, description}`.
  - The name is `"KEY: Summary"`, trimmed exactly the way `Issue.create` normalizes names, so a fresh import is never classified as a Conflict.
  - The description is the Description markdown. When DOD is non-empty, append `"\n\n## Definition of Done\n<dod>"`. When both are empty, the description is empty.
- [x] `src/domain/jira-import.ts`: `classifyJiraIssue(composed, jiraKey, existingIssues)`.
  - Returns `{kind:'new'}` or `{kind:'duplicate'|'conflict', issueId, issueName}`.
  - Matches on `jiraKey`, then compares name and description exactly.
- [x] `src/domain/jira-import.ts`: sprint helpers.
  - `orderSprints(sprints)`: dedupe by id, then order active → future → closed.
  - `matchesSprintFilter(issue, filter)`: matches by id, or by a case-insensitive name substring for free text.
- [x] Tests: extend `src/domain/issue.test.ts`.
  - Source defaults to `local`.
  - The jira source/key invariant.
  - The snapshot round trip keeps `source` and `jiraKey`.
- [x] Tests: NEW `src/domain/jira-import.test.ts`.
  - Compose: empty DOD left out; null or empty description; name trimming.
  - Classify: new; duplicate; conflict on a name difference; conflict on a description difference; a locally edited import becomes a conflict; a deleted issue becomes new again.
  - Sprint ordering and matching.
- [x] Extend `src/domain/workspace.test.ts`: hydrated and newly created issues default to `source: 'local'`.

### [x] Subject 2: Shared IPC contract
- [x] `src/shared/dto.ts`: add `IssueSourceDTO = 'local'|'jira'`, and a required `source` plus optional `jiraKey?` on `IssueDTO`.
- [x] `src/shared/dto.ts`: add the filter DTOs.
  - `JiraProjectDTO` and `JiraSprintDTO`.
  - `JiraSprintFilterDTO`: `{kind:'id',id,name}` or `{kind:'name',text}`.
  - `JiraFiltersDTO`: project?, assignee?, issueKey?, days?, sprint?.
- [x] `src/shared/dto.ts`: add the result DTOs.
  - `JiraIssueRowDTO`: key, summary, status, priority, type, assignee?, reporter?, created, sprintNames, descriptionMarkdown, dodMarkdown, classification.
  - `JiraSearchPageDTO`: rows, `nextCursor?: string`, total.
- [x] `src/shared/dto.ts`: add the error envelope, so error kinds survive IPC (thrown Error classes don't).
  - `JiraErrorDTO`: `kind: 'noKey'|'unauthorized'|'unreachable'|'gateway'|'invalid'`, message.
  - `JiraResultDTO<T>`: `{ok:true,value}` or `{ok:false,error}`.
- [x] `src/shared/dto.ts`: add `ImportJiraIssuesInput {keys}`, `ImportJiraIssuesResultDTO` (ok, importedCount, skippedKeys, error?) and `SetJiraKeyInput {key: string|null}`.
- [x] `src/shared/dto.ts`: add `jira?: { lastFilters?: JiraFiltersDTO }` to `SettingsDTO` and `SettingsPatchDTO`. Never add the key here.
- [x] `src/shared/ipc.ts`: new request/reply `CHANNELS`: `jiraProjects`, `jiraSprints`, `jiraSearch`, `jiraImport`, `credentialsSetJiraKey`, `credentialsHasJiraKey`.
- [x] `src/shared/ipc.ts`: new `OctopusAPI` groups.
  - `jira { projects(), sprints(project), search(filters, cursor?), import(input) }`.
  - `credentials { setJiraKey(key|null), hasJiraKey(): Promise<boolean> }`.
  - Doc comments state that the key never returns to the renderer.
- [x] NEW `src/shared/jira-key.ts`: pure `normalizeJiraIssueKey` and `isJiraIssueKey` (trim, uppercase, `PROJ-123` shape). The renderer uses it for input and main for validation, the same way `external-url.ts` is shared.
- [x] Test: NEW `src/shared/jira-key.test.ts`: valid keys, lowercase, whitespace, a missing number, comma lists rejected.

### [x] Subject 3: ADF-to-markdown converter (pure)
- [x] NEW `src/adapters/jira/adf-to-markdown.ts`: `adfToMarkdown(doc: unknown): string`.
  - Nodes: paragraph, heading (levels 1–6), bulletList/orderedList/listItem (nested lists indented), codeBlock (fenced, using `attrs.language`), hardBreak, rule.
  - Text marks: strong, em, code, link (link only when `href` is a string).
- [x] Unknown nodes recurse into `content`, otherwise fall back to `text`. `null`, non-objects and malformed input return `''`.
- [x] Make the output deterministic, since classification compares it byte for byte: collapse 3+ blank lines and trim.
- [x] Test: NEW `src/adapters/jira/adf-to-markdown.test.ts`: each node type and mark, nested lists, an unknown node, null/undefined/string input, and an ADF doc from the fixtures.

### [x] Subject 4: Gateway fixtures (captured once, scrubbed)
- [x] NEW `test/fixtures/jira/`: capture raw gateway JSON envelopes with the reference client (`/home/udim/bin/jira raw ...`).
  - `search-page1.json`, `search-page2.json`, `search-no-issues.json`.
  - `get-issue-batch.json`: several issues with `---` separators.
  - `get-issue-sprints.json`: active, future and closed sprints, a null Sprint, a null DOD.
  - `projects.json` and `is-error.json`.
- [x] Scrub emails, avatar URLs and accountIds (replace with placeholders), and keep displayNames generic.
- [x] NEW `test/fixtures/jira/README.md`: the capture commands and the scrubbing rule.

### [x] Subject 5: Settings backend — `jira.lastFilters`
- [x] `src/ports/settings-store.ts`: add `JiraLastFilters` (project?, assignee?, issueKey?, days?, sprint?), `JiraSettings { lastFilters? }`, and `jira?: JiraSettings` on `Settings` and on the port's `SettingsPatch`. Document them as non-secret.
- [x] `src/adapters/settings/json-settings-store.ts`: add `pickJira` to `mergeSettings`.
  - Keep known keys only: strings trimmed, `days` a positive integer, `sprint` one of the two shapes. Drop anything else.
  - Leave `DEFAULT_SETTINGS` without a `jira` block, so serializing and re-parsing still gives the same settings.
- [x] Test: extend `src/adapters/settings/json-settings-store.test.ts`: absent by default; patch round trip; a malformed `jira` block is dropped; an unrelated patch keeps `lastFilters`.

## Wave 2 (depends on Wave 1)

### [x] Subject 6: Ports — JiraIssueSource and CredentialsProvider
- [x] NEW `src/ports/jira-issue-source.ts`: the `JiraIssueSource` interface and a `JiraSearchFilters` type.
  - `listProjects(): Promise<JiraProject[]>`.
  - `listSprints(project): Promise<JiraSprint[]>`.
  - `search(filters, cursor?): Promise<{issues: JiraIssue[], nextCursor?: string, total: number}>`.
  - `getIssues(keys): Promise<JiraIssue[]>`.
- [x] `src/ports/jira-issue-source.ts`: `JiraSourceError` with `kind: 'noKey'|'unauthorized'|'unreachable'|'gateway'`.
- [x] `src/ports/credentials-provider.ts`: keep `resolve(ref)`, and add:
  - `set(ref, secret: string|null): Promise<void>` and `has(ref): Promise<boolean>`.
  - A `JIRA_API_KEY_REF` constant.
  - A module doc update: this is the first implementation, encrypted at rest (I16).

### [x] Subject 7: Persistence — schema v10
- [x] `src/adapters/persistence/schema.ts`: set `SCHEMA_VERSION = 10`.
  - Add `source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','jira'))` and `jira_key TEXT` to the bootstrap `issues` DDL in `SCHEMA_STATEMENTS`.
  - Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_jira_key ON issues(jira_key)`. SQLite's `ALTER TABLE ADD COLUMN` can't add a UNIQUE column; NULLs stay distinct.
- [x] `src/adapters/persistence/schema.ts`: append `{ toVersion: 10 }`.
  - Statements: `ALTER TABLE issues ADD COLUMN source ...`, `ALTER TABLE issues ADD COLUMN jira_key TEXT`, and the same unique index.
  - Never edit the v1–v9 DDL. Update the version-history doc comment.
- [x] Guard the v10 `ALTER`s.
  - Why: `SqliteStore` runs `SCHEMA_STATEMENTS` before the migrations. On a v7 DB the bootstrap therefore creates `issues` with the new columns, and a bare `ALTER` fails with "duplicate column".
  - Add an optional per-migration `unlessColumnExists {table, column}` guard to `Migration`.
  - Check it in `runMigrations` in `src/adapters/persistence/sqlite-store.ts` using `PRAGMA table_info`.
- [x] `src/adapters/persistence/mappers.ts`: add `source` and `jira_key` to `IssueRow`.
  - `issueToRow` writes both.
  - `rowToIssueSnapshot` parses `source` with `parseIssueSource`, falling back to `local` for a corrupt value. A NULL `jira_key` maps to `undefined`.
- [x] `src/adapters/persistence/sqlite-store.ts`: add `source` and `jira_key` to the `upsertIssue` INSERT column list. In `ON CONFLICT(id) DO UPDATE`, leave `source` alone (it never changes) and keep `jira_key` stable.
- [x] Tests: extend `src/adapters/persistence/mappers.test.ts`: local and jira round trips, a NULL key, a corrupt source falls back to local.
- [x] Tests: extend `src/adapters/persistence/sqlite-store.test.ts` (FakeDb).
  - Version stamped 10, and v10 runs when starting from 9.
  - The v10 ALTERs are skipped when `table_info` already lists the columns (the v7 path).
  - v10 does not run on a fresh DB.
  - The upsert SQL carries the new parameters.

### [x] Subject 8: Preload bridge
- [x] `src/preload/index.ts`: add `jira.projects/sprints/search/import` and `credentials.setJiraKey/hasJiraKey`, each via `ipcRenderer.invoke` on the new `CHANNELS`.

### [x] Subject 9: Renderer store and test support
- [x] `src/renderer/src/store/store.ts`: hydrate and reduce `IssueDTO.source`/`jiraKey` unchanged (`issueUpserted` already replaces the whole DTO).
- [x] `src/renderer/src/store/store.ts`: add `setJiraLastFilters(filters)`. It patches only `settings.jira.lastFilters` (same pattern as the `groupTasksByRepo` setter), so reopening the modal prefills without a re-hydrate.
- [x] `src/renderer/src/store/store.ts`: move the Settings modal's open state into the store as renderer-local view state that is never persisted: `settingsOpen`, `openSettings`, `closeSettings`. It survives `hydrate()`, like the drawer fields.
- [x] `src/renderer/src/test-support/stub-bridge.ts`: add `jira` and `credentials` groups with sensible defaults (`hasJiraKey` resolves `false`, the project list is empty).
- [x] Update the `IssueDTO` literals to include `source: 'local'` in:
  - `src/renderer/src/App.test.tsx`
  - `DeleteTaskConfirm.test.tsx`, `IssuesDrawer.test.tsx`, `LinkTaskPicker.test.tsx`, `NewTaskModal.test.tsx`, `TaskListItem.test.tsx`
  - `src/renderer/src/store/group-issues.test.ts`, `src/renderer/src/store/store.test.ts`
- [x] Test: extend `src/renderer/src/store/store.test.ts`: an issue hydrates with `source`/`jiraKey`; `setJiraLastFilters` changes only that field; `settingsOpen` toggles and survives a re-hydrate.

## Wave 3 (depends on Wave 2)

### [x] Subject 10: LiteLLM Jira adapter
- [x] NEW `src/adapters/jira/litellm-jira-source.ts`: `LiteLLMJiraSource implements JiraIssueSource`.
  - The constructor takes `{ fetch, getApiKey: () => Promise<string|undefined>, baseUrl, serverId, timeoutMs }`.
  - It POSTs to `/mcp-rest/tools/call` with `Authorization` (prefixed with `Bearer ` if missing) and `Content-Type: application/json`.
- [x] The wire tool name carries the `jira_` server alias prefix, e.g. `jira_jira_search` (verified against the live gateway). Pin it in a test.
- [x] Error mapping:
  - Missing key: throw `JiraSourceError('noKey')` before any fetch.
  - HTTP 401/403: `unauthorized`.
  - Fetch rejection, DNS failure or `AbortSignal.timeout`: `unreachable`.
  - Any other non-2xx, `isError: true`, or a malformed envelope: `gateway`.
  - Never put the key or headers in error messages or logs.
- [x] Parse `jira_search` text.
  - The "Found N total issues ..." header gives `total`.
  - Each `• [PROJ] KEY - Summary` bullet gives a key and its preview lines.
  - "No issues found with filters: ..." is an empty page, not an error.
- [x] Parse `jira_get_issue` text. For each `Issue KEY details:` block, read the JSON (a string-aware brace scan) and skip the `---` separator.
  - Summary, Description and `dod` go through `adfToMarkdown`.
  - Sprint[] (null becomes `[]`), the Status/Priority/Type names, the Assignee/Reporter displayName, Created and Project.
  - Keys missing from the response are dropped.
- [x] `getIssues(keys)`: dedupe, then request in batches of 10 comma-separated keys, in order.
- [x] `search(filters, cursor)`:
  - With `issueKey`: skip search and call `getIssues([key])` (total 1, no cursor).
  - Otherwise: page through `jira_search {project, assignee?, days?, limit: 50, offset}` and fetch details for the hits.
  - With no sprint filter: return them, with `nextCursor = offset+50` while below `total`.
- [x] Sprint filter (inside `search`):
  - Keep scanning whole 50-hit search pages, filtering in the app with `matchesSprintFilter`, until there are 50 or more matches or the results run out.
  - Never split a search page across cursors.
  - Cap the number of search pages per call; at the cap, still return `nextCursor`.
- [x] `listSprints(project)`: `jira_search {project, days:30, limit:30}`, then `getIssues` in batches, then `orderSprints`.
- [x] `listProjects()`: parse the `  • KEY: N tickets` lines.
- [x] Test: NEW `src/adapters/jira/litellm-jira-source.test.ts`, with an injected fetch that serves `test/fixtures/jira/*`.
  - Request shape: URL, wire tool name, `server_id`, Bearer prefixing.
  - Parsing: search text, "No issues found", multi-block `---` parsing, projects.
  - Batching: 11+ keys become batches of 10 and 1.
  - Errors: 401/403, network error, timeout, `isError: true`.
  - Sprints: ordering, and the filter scanning across pages (cursor advance and exhaustion).
  - Key lookup: no `jira_search` call is made.

### [x] Subject 11: SafeStorage credentials adapter
- [x] `src/adapters/env/paths.ts`: add `credentialsDir` (`<dataDir>/credentials`) to `AppPaths`/`resolveAppPaths`. `ensureAppDirs` creates it with mode 0700.
- [x] NEW `src/adapters/credentials/safe-storage-credentials.ts`: `SafeStorageCredentials implements CredentialsProvider`.
  - It takes an injected `safeStorage`-like object and the directory, and stores each sanitized ref as `<dir>/<ref>.bin`.
  - `set` encrypts with `encryptString` and writes atomically (temp file, then rename) with mode 0600. A `null` secret deletes the file.
  - `has` checks that the file exists. `resolve` decrypts it, and throws if the file is missing.
- [x] Call `safeStorage` only inside the methods, never at construction. `bootstrap()` runs before `app.whenReady` (`src/main/index.ts`), when safeStorage isn't available yet.
- [x] If `isEncryptionAvailable()` is false, `set` rejects with a clear message. If the Linux backend is `basic_text`, log a warning (without the key).
- [x] Tests: extend `src/adapters/env/paths.test.ts` to cover `credentialsDir`.
- [x] Tests: NEW `src/adapters/credentials/safe-storage-credentials.test.ts`, with a mocked safeStorage over a temporary directory.
  - set, has, resolve and clear.
  - The file mode is 0600, and the stored bytes are not the plaintext.
  - Encryption unavailable rejects; resolving a missing key throws.

### [x] Subject 12: Application — preview query and the `importJiraIssues` command
- [x] NEW `src/application/queries/preview-jira-issues.ts`: `previewJiraIssues(deps, issues: JiraIssue[])` composes and classifies each issue against `deps.workspace.issues()`, returning `{issue, composed, classification}[]`. It is a pure read and bypasses the command loop.
- [x] `src/application/commands.ts`:
  - Add `ImportJiraIssuesInput { issues: readonly JiraIssue[] }` (main fetches these beforehand) and the `{kind:'importJiraIssues'}` `Command` member.
  - Add `importedCount?` and `skippedKeys?` to `CommandResult`.
  - Add `jira?` to the application `SettingsPatch`, matching the port's shape.
- [x] NEW `src/application/use-cases/import-jira-issues.ts`:
  - Re-classify every issue against the current workspace and skip duplicates and conflicts.
  - Build each new issue with `Issue.create({source: Jira, jiraKey, status Todo, no projectPath})`.
  - Run every `upsertIssue` inside one `deps.persistence.transaction`.
  - Only after it commits, call `workspace.addIssue` and publish `issueUpserted` for each issue. This is the persist-before-mutate order from `create-issue.ts`, so a rollback leaves memory untouched.
  - Return the created count and the skipped keys.
- [x] `src/application/command-loop.ts`: route `importJiraIssues`.
- [x] `src/application/use-cases/test-fakes.ts`: add `FakePersistence.failUpsertIssueAt?: number` (throws on the Nth `upsertIssue` inside a transaction), and a `FakeJiraIssueSource` with seeded issues and an error injector.
- [x] Tests: NEW `src/application/queries/preview-jira-issues.test.ts`.
- [x] Tests: NEW `src/application/use-cases/import-jira-issues.test.ts`.
  - Creates N issues with the right fields.
  - Skips duplicates and conflicts even when they are requested.
  - A second import of the same key is skipped.
  - A failure mid-batch leaves the workspace and events untouched.
  - One event per created issue.
- [x] Tests: extend `src/application/use-cases/create-issue.test.ts` (source is local), and update the `IssueSnapshot` literals in `src/application/use-cases/delete-task.test.ts`.

### [x] Subject 13: Renderer — JiraImportModal
- [x] NEW `src/renderer/src/components/JiraImportModal.tsx`, following the overlay contract.
  - Portaled to `document.body`, with the `overlayStyle` backdrop.
  - The card has `role="dialog"`, `aria-modal="true"` and `tabIndex={-1}`.
  - Its `onKeyDown` calls `stopPropagation()` for every key; Escape closes only the modal.
  - No blur or filter.
- [x] Filters, prefilled from `settings.jira.lastFilters`:
  - Project: a dropdown filled from `jira.projects()`.
  - Assignee, Issue key, and Created in last N days.
  - Sprint: a dropdown from `jira.sprints(project)`, with None first and selectable, then active, future and closed. It loads per project, with a loading state, and falls back to free text when there are no sprints.
  - The hint "Jira data refreshes every few hours".
- [x] Fetch:
  - Disabled unless a Project or an Issue key is set; an Issue key overrides the other filters.
  - On Fetch, call `jira.search`, `app.updateSettings({jira:{lastFilters}})` and the store's `setJiraLastFilters`.
  - Load more passes `nextCursor`.
- [x] Result rows: checkbox, KEY, summary, and the Jira status/type/assignee as read-only info. Duplicate and Conflict rows are grayed, with the checkbox disabled and the label "Duplicated by <name>" or "Conflicts with <name>".
- [x] Clicking a row shows a read-only detail pane: key, summary, status, priority, type, assignee, reporter, created, sprint, and the Description and DOD rendered with `IssueMarkdown`.
- [x] Footer: Select all (selects only the loaded New rows), "N selected", and Import.
  - Import calls `jira.import({keys})`.
  - On success the modal closes, and the issue list refreshes through `issueUpserted` events.
  - Skipped keys and errors are shown inline.
- [x] Error states:
  - On open, if `credentials.hasJiraKey()` is false: "No Jira API key", with **Open Settings**.
  - `unauthorized`: "key rejected", with **Open Settings**.
  - `unreachable`: "gateway unreachable", with Retry.
  - Open Settings closes this modal first, then calls the store's `openSettings()`. Because the portaled modal comes after `#root` in the DOM, it would otherwise paint over Settings.
- [x] Test: NEW `src/renderer/src/components/JiraImportModal.test.tsx`.
  - Filters: prefilled from saved settings; sprint dropdown order; free-text fallback.
  - Rows: render; duplicate and conflict rows grayed, labelled and unselectable; Select all selects only New.
  - Interaction: a row click shows the detail; Import sends the selected keys and closes; Load more.
  - Each error state, and Open Settings calls `openSettings`.
  - A window `keydown` spy never fires (pattern: `NewTaskModal.test.tsx`).

### [x] Subject 14: Renderer — Settings key field, Settings state move, IssueDetail source line
- [x] `src/renderer/src/components/SettingsModal.tsx`: a "Jira API key" `type="password"` field on the General tab.
  - It always starts empty; its placeholder reads "Key saved" when `hasJiraKey()` is true.
  - Save calls `credentials.setJiraKey(value)` only when the field is non-empty.
  - A "Clear key" button calls `setJiraKey(null)`.
  - Errors are shown, e.g. "secure storage unavailable".
- [x] `src/renderer/src/components/ProgressPanel.tsx`: replace the local `showSettings` state with the store's `settingsOpen`/`openSettings`/`closeSettings`.
- [x] `src/renderer/src/components/IssueDetail.tsx`: a read-only "Source: Jira (KEY)" or "Source: Local" line in the view-mode toolbar area. It is never editable and does not appear in the edit form.
- [x] Tests: extend `src/renderer/src/components/SettingsModal.test.tsx`: the field never shows the key; set and clear calls; the `updateSettings` patch never contains the key.
- [x] Tests: extend `src/renderer/src/components/ProgressPanel.test.tsx`: the settings button opens Settings through the store.
- [x] Tests: extend `src/renderer/src/components/IssueDetail.test.tsx`: the source line for both sources, absent from the edit form; add `source` to the fixtures.

## Wave 4 (depends on Wave 3)

### [x] Subject 15: Main — DTO mappers, IPC handlers, composition root
- [x] `src/main/dto-mappers.ts`:
  - `toIssueDTO` carries `source`/`jiraKey`, and `toSettingsDTO` carries `jira`.
  - Add `toJiraIssueRowDTO(preview)`, `toJiraSprintDTO` and `toJiraProjectDTO`.
  - Add `toJiraErrorDTO(err)`: a `JiraSourceError` maps to its kind and anything else to `gateway`, with the message scrubbed.
- [x] `src/main/ipc-handlers.ts`: add `jira: JiraIssueSource` and `credentials: CredentialsProvider` to `IpcHandlerHooks` (`clipboard` is the precedent).
- [x] `src/main/ipc-handlers.ts`: exported pure validators.
  - `parseJiraFilters`.
  - `parseImportKeys`: an array, non-empty, capped and deduped, with each key passing `isJiraIssueKey`.
- [x] `src/main/ipc-handlers.ts`: `jira:projects`, `jira:sprints` and `jira:search` are queries that bypass the loop. `search` calls the port, then `previewJiraIssues`, then the row DTOs, and returns a `JiraResultDTO`.
- [x] `src/main/ipc-handlers.ts`: `jira:import`.
  - Validate the keys, then call `port.getIssues(keys)` outside the loop.
  - Dispatch `importJiraIssues` and reply with `ImportJiraIssuesResultDTO`.
  - Report keys that Jira didn't return as skipped.
- [x] `src/main/ipc-handlers.ts`: credentials handlers. `credentials:setJiraKey` accepts a trimmed string of 1–4096 characters, or `null`. `credentials:hasJiraKey` returns only a boolean. The key is never logged or returned.
- [x] `src/main/composition-root.ts`: wire the adapters, then pass both into the `registerIpcHandlers` hooks. This stays the only place adapters are imported.
  - Build `SafeStorageCredentials(safeStorage, paths.credentialsDir)`.
  - Build `LiteLLMJiraSource` with `fetch: globalThis.fetch`, `baseUrl`, `serverId`, and a `getApiKey` that resolves `JIRA_API_KEY_REF` through the credentials provider and returns undefined when there's no key.
- [x] Tests: extend `src/main/dto-mappers.test.ts`: issue `source`/`jiraKey`, settings `jira`, the row DTO for each classification, error mapping.
- [x] Tests: extend `src/main/ipc-handlers.test.ts`.
  - Bad filters and keys are rejected before any port call.
  - The issue-key path.
  - Import fetches first, then dispatches.
  - `hasJiraKey` never leaks the value.
  - Port errors map to the right `JiraResultDTO` kinds.

### [x] Subject 16: Renderer — Issues drawer integration
- [x] `src/renderer/src/components/IssueList.tsx`: a "Fetch from Jira" header button next to "+ New Issue" that opens `JiraImportModal` (local open state), and a small "Jira" badge on rows where `source==='jira'` (plain paint, no filter).
- [x] `src/renderer/src/components/IssuesDrawer.tsx`: add `JiraImportModal` to the `topmostModal()` doc-comment list. Confirm that Escape and focus are handed to the open modal without closing the drawer.
- [x] Tests: extend `src/renderer/src/components/IssueList.test.tsx`: the button opens the modal; the Jira badge appears only on jira rows; add `source` to the fixtures.
- [x] Tests: extend `src/renderer/src/components/IssuesDrawer.test.tsx`: Escape inside the Jira modal closes the modal, not the drawer.

## Wave 5 (depends on Wave 4)

### [ ] Subject 17: Integration test and real-SQLite probe
- [x] NEW `test/integration/jira-import.integration.test.ts`: a real `CommandLoop` over `makeDeps()`, plus `LiteLLMJiraSource` with a fixture-serving fetch.
  - Search → preview (all New) → import.
  - `Workspace.hydrate(fd.persistence.load())` stands in for the reload; search again and the row is a Duplicate.
  - `updateIssue` renames it → Conflict; `deleteIssue` → New again.
- [x] `scripts/probe-sqlite-store.cjs`: v9→v10 and v7→v10 against the real SQLite binary, then run `npm run probe:sqlite`.
  - Old rows become `local` with a NULL `jira_key`.
  - A duplicate `jira_key` raises UNIQUE, and a bad `source` raises CHECK.
  - Two NULL keys are allowed.
  - `.bak-v9` is written.

### [x] Subject 18: Docs
- [x] `DESIGN.md`: a new §13.7 "Jira import", covering:
  - The `JiraIssueSource` port, the LiteLLM adapter and its text formats, and the ADF conversion.
  - Query vs. command: main fetches first, and the command loop re-classifies.
  - The classification rules.
  - Schema v10: the unique index and the guarded ALTER.
  - `settings.jira.lastFilters` and the error kinds.
- [x] `DESIGN.md` I16 (§7): `CredentialsProvider` is now implemented for the Jira key. It is encrypted at rest via safeStorage with mode 0600, never stored in the DB or settings.json, and never returned to the renderer. Add the `credentials/` dir to the §6.3 data-dir notes.
- [x] `PRD.md` Issues:
  - Add Source to Fields.
  - New "Importing from Jira" subsection: the button, filters, sprint behavior, row states, imported issue shape, badge and source line, API key and error states.
  - Remove "Fetch issues from Jira" from Future.
- [x] `TASKS.md`: a "Jira import" section mirroring this plan.
- [x] `CHANGELOG.md` [Unreleased] Added: Jira import, plus the schema v10 note (an `octopus.db.bak-v9` backup is written; older builds refuse the DB).

### [x] Subject 19: Full gate
- [x] `npm run typecheck && npm run lint && npm run test && npm run format:check` all pass, including the boundaries rule:
  - No `adapters` import outside `src/main/composition-root.ts`.
  - No `ports` import in the renderer.
  - `domain` imports nothing.
- [ ] Manual smoke test with `npm run dev` against the live gateway: no key → Open Settings → save key → fetch a project → sprint dropdown → import → badge → re-fetch shows Duplicate.

## Testing
- [x] Fixtures come only from scrubbed captures in `test/fixtures/jira/` (no emails, avatar URLs or accountIds). No test calls the live gateway; every adapter test injects `fetch`.
- [x] Domain:
  - Classify: new; duplicate; conflict on a name difference and on a description difference; a locally edited import becomes a conflict; a deleted issue becomes new again.
  - Compose: empty DOD left out; null description; the name trimmed exactly like `Issue.create`.
  - The Issue source/jiraKey invariant and snapshot round trip; existing issue and workspace tests default to `local`.
- [x] Compose stability: a freshly imported issue's stored name and description equal `composeJiraIssue` output byte for byte, even when the ADF output has trailing whitespace or runs of blank lines. A re-fetch is therefore Duplicate, never Conflict.
- [x] ADF adapter: every node type and mark, nested lists, unknown nodes, null and malformed input.
- [x] Jira source adapter:
  - Request: wire tool name and `server_id`, Bearer prefixing.
  - Parsing: search text, "No issues found", multi-block `---` parsing with trailing separators and extra whitespace, projects.
  - Errors: 401/403, network error, timeout, `isError: true`.
  - Behavior: batches of 10, sprint ordering, the sprint-filter scan across pages (no hit lost or duplicated between cursors), the key-lookup path.
- [x] Persistence (FakeDb plus the real-binary probe):
  - v9→v10: old rows become `local` with a NULL `jira_key`.
  - v7→v10 does not fail with a duplicate column.
  - UNIQUE and CHECK are enforced, and a fresh DB skips the migrations.
  - The `upsertIssue` round trip keeps source/jiraKey.
- [x] Credentials: set, has, resolve and clear with a mocked safeStorage; file mode 0600; the stored bytes aren't the plaintext; encryption unavailable; no safeStorage call at construction time.
- [x] Application: `importJiraIssues`
  - Creates N issues with status todo, no project, source jira.
  - Re-classifies and skips duplicates and conflicts even when they are requested; a second import of the same key is skipped.
  - A persistence failure mid-batch leaves the workspace untouched and publishes no events.
  - Exactly one `issueUpserted` per created issue.
- [x] Main: `ipc-handlers` rejects malformed filters and keys before any port call; the credential handlers never return or log the key; error kinds map correctly; the dto-mappers seam covers the new fields and the row DTO.
- [x] Renderer — modal:
  - Prefilled from saved filters; rows render; duplicate and conflict rows grayed, labelled and unselectable; Select all selects only New.
  - A row click shows the detail pane; Import sends the selected keys and closes; Load more.
  - Error states: no key and key rejected show Open Settings (closes the modal, opens Settings); unreachable shows Retry.
  - A window keydown spy proves no key leaks; Escape closes only the modal.
- [x] Renderer — elsewhere: the IssueList Jira badge, the IssueDetail source line, and SettingsModal never showing the key.
- [x] Integration (`test/integration/jira-import.integration.test.ts`): import → reload from persistence → search again shows Duplicate; a local rename shows Conflict; deleting shows New.

## Acceptance Criteria
- The Issues drawer header has "Fetch from Jira" next to "+ New Issue". It opens a modal that follows the overlay contract: portaled, `aria-modal`, keys never reach the window shortcuts, and listed in the `topmostModal()` doc comment.
- Filters:
  - Project is required unless an Issue key is set, and the key overrides the other filters.
  - The Sprint dropdown lists active, then future, then closed, plus None; it becomes free text when a project has no sprints.
  - The last-used filters are prefilled on the next open.
- Results:
  - They load in pages of 50 with "Load more". Each row shows the key, the summary, and the read-only Jira status/type/assignee.
  - Clicking a row shows a read-only detail pane with the Description and DOD rendered as markdown.
- Row states:
  - New rows are selectable.
  - Duplicate and Conflict rows are grayed and unselectable, labelled "Duplicated by …" or "Conflicts with …".
  - Select all selects only New rows.
- An imported issue has:
  - The name `KEY: Summary`.
  - A markdown description, with a "## Definition of Done" section only when DOD is non-empty.
  - Status Todo, no project, `source='jira'`, and the stored `jiraKey`. The Jira status is never imported.
- Import behavior:
  - An import is one all-or-nothing transaction.
  - An unchanged issue can't be imported twice (it shows as Duplicate).
  - A locally edited import shows as Conflict, and a deleted import can be imported again.
- Imported issues show a "Jira" badge in IssueList and "Source: Jira (KEY)" in IssueDetail; local issues show "Source: Local". The source can't be edited.
- The Jira API key:
  - It is set in Settings and stored encrypted via safeStorage in `<dataDir>/credentials/` with mode 0600.
  - It is never returned to the renderer, nor written to settings.json or the DB.
- The modal shows distinct states for no key (with Open Settings), key rejected, and gateway unreachable.
- Schema v10 upgrades v7, v8, v9 and fresh DBs, writing the backup. Older builds refuse a v10 DB with `IncompatibleDbError`.
- `npm run typecheck`, `lint` (boundaries), `test` and `format:check` all pass. DESIGN.md (§13.7, I16), PRD.md, TASKS.md and CHANGELOG.md are updated.
