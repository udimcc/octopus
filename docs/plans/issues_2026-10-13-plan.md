# Issues - Plan

**Feature**: Issues stored locally (name, markdown description, optional project, 4-state status). Each issue can be bound 1:1 to a task. Issues are managed in a drawer that slides in over the main window's session area, and they are connected to the New-Task modal, the task rows and task deletion.

**Design**: `docs/plans/issues_2026-10-13-design.md` · **Product spec**: `PRD.md` → *Issues*

> **Verification note (read first).** Several unions are switched on exhaustively, with a `never` default: `reduceEvent` in `src/renderer/src/store/store.ts`, `toEventDTO` in `src/main/dto-mappers.ts`, and `CommandLoop.handle` in `src/application/command-loop.ts`. Contract subjects add union members one or two waves before the consumer that handles them, so whole-tree `npm run typecheck` is expected to fail between waves. During Waves 1–3, each subject verifies itself with its co-located tests via `npx vitest run <files>` (esbuild transpiles without typechecking). The full gate (`npm run typecheck && npm run lint && npm run test && npm run format:check`) runs at the end of Wave 4.

## Wave 1 (parallel)

### Subject 1: Domain — Issue entity + Workspace binding rules
- [x] `src/domain/ids.ts`: add branded `IssueId` and `asIssueId`.
- [x] New `src/domain/issue.ts`:
  - `IssueStatus` enum: `Todo='todo'`, `InProgress='in_progress'`, `InReview='in_review'`, `Done='done'`.
  - `Issue` aggregate with `create`/`fromSnapshot`, `rename` (trimmed, must be non-empty, otherwise `InvariantViolationError`), `setDescription`, `setProject(path|undefined)`, `setStatus`, `touch(now)` and `toSnapshot`.
  - Binding fields are changed only through `Workspace`.
- [x] `src/domain/snapshots.ts`:
  - Add `IssueSnapshot` (`id`, `name`, `description`, `projectPath?`, `status`, `taskId?`, `createdAt`, `updatedAt`).
  - Add `issues?: readonly IssueSnapshot[]` to `WorkspaceSnapshot`. It is optional so existing snapshot fixtures still compile.
- [x] `src/domain/workspace.ts`, issues collection: `issues()`, `issue(id)`, `addIssue` (id must be unique), `removeIssue`, `issueForTask(taskId)`.
- [x] `src/domain/workspace.ts`, binding (new invariant I19, 1:1):
  - `bindIssue(issueId, taskId)`: the task must exist. Throw if the task is bound to a different issue. If this issue was bound to another task, replace that binding silently. Move `Todo`→`InProgress` only when the status is `Todo`.
  - `unbindIssue(issueId)`: leaves the status unchanged.
- [x] `src/domain/workspace.ts`, project, task removal and hydration:
  - `removeTask` also clears the binding of any issue bound to that task. Status is unchanged.
  - `clearIssueProject(projectPath): Issue[]` matches projects with `canonProjectPath` from `src/domain/project-path.ts`.
  - `hydrate` loads `snap.issues ?? []` and drops bindings to tasks that are not present.
  - `toSnapshot` emits `issues`.
- [x] Tests:
  - New `src/domain/issue.test.ts`: name validation, the status set, snapshot round trip.
  - Extend `src/domain/workspace.test.ts`: binding a task that has another issue is rejected; rebinding replaces the old binding; todo→in_progress happens only from todo; unbind keeps the status; removeTask unbinds; `clearIssueProject` matches canonical paths; hydrate drops dangling bindings.

### Subject 2: Shared IPC contract
- [x] `src/shared/dto.ts`, new types:
  - `IssueStatusDTO` (`'todo'|'in_progress'|'in_review'|'done'`) and `IssueDTO`.
  - `CreateIssueInput {name, description, projectPath?, status?}`.
  - `UpdateIssueInput {issueId, name?, description?, projectPath?: string|null, status?}`. `null` clears the project.
  - `DeleteIssueInput`, `BindIssueInput {issueId, taskId}`, `UnbindIssueInput`, `OpenExternalInput {url}`.
- [x] `src/shared/dto.ts`, changes to existing types:
  - `issueId?` on `CreateTaskFromNewInput`, `CreateTaskFromExistingInput` and `CreateTaskFromNoneInput`.
  - `alsoDeleteIssue?` on `DeleteTaskInput`.
  - `issues: readonly IssueDTO[]` on `WorkspaceStateDTO`.
  - `issuesKey?` on `SettingsDTO` and `SettingsPatchDTO`.
  - `issueId?` on `CommandAck`, returned by create.
- [x] `src/shared/events.ts`:
  - `IssueUpsertedEventDTO {type:'issueUpserted', issue}` and `IssueDeletedEventDTO {type:'issueDeleted', issueId}`.
  - `IssuesDrawerToggleEventDTO {type:'issuesDrawerToggle'}`, synthesized in main like `sessionSeen`.
  - Add all three to `EventDTO`.
- [x] `src/shared/ipc.ts`:
  - New `CHANNELS`: `issueCreate`, `issueUpdate`, `issueDelete`, `issueBind`, `issueUnbind` and `shellOpenExternal` (request/reply); `issuesToggleDrawer` (fire-and-forget `send`).
  - New `OctopusAPI` groups: `issues {create, update, delete, bind, unbind, toggleDrawer(): void}` and `shell {openExternal(input): Promise<boolean>}`.
- [x] New `src/shared/external-url.ts`: pure `isSafeExternalUrl(url)`. It parses with `new URL` and allows only `http:` and `https:`. Main uses it to validate; the renderer uses it to filter links.
- [x] Test: new `src/shared/external-url.test.ts` covering http, https, `javascript:`, `file:`, `mailto:`, relative, malformed and whitespace URLs.

### Subject 3: Markdown dependency
- [x] `package.json` + `package-lock.json`: `npm install --save-exact react-markdown@10.1.0 remark-gfm@4.0.1` through the Artifactory proxy configured in `.npmrc`.
  - Both versions were confirmed on the mirror. react-markdown 10 has a peer dependency of `react>=18`.
  - Add them to `dependencies`, like the other renderer libraries.
  - Do not add `rehype-raw`.
- [x] Check that `npm run build` still bundles the renderer (both packages are ESM-only; vite handles this) and that the native-module `postinstall` still passes.

### Subject 4: Issues shortcut setting (backend side)
- [x] `src/ports/settings-store.ts`: add `issuesKey?` to `Settings` and `SettingsPatch`, and update the defaults doc comment.
- [x] `src/adapters/settings/json-settings-store.ts`: default `issuesKey: 'Alt+Shift+KeyI'` (the canonical chord format from `modifierPrefix`/`parseChord`), merged with `pickString(patch.issuesKey, base.issuesKey)`.
- [x] Test: extend `src/adapters/settings/json-settings-store.test.ts` to cover the default, patching and persistence.

### Subject 5: Docs
- [x] `PRD.md`: new "Issues" section, the "Issues" button under Progress Window → Controls, and a UI Layout note. Written during the brainstorm.
- [x] `DESIGN.md`: short "Issues" section covering:
  - the `Issue` entity;
  - invariant I19 (1:1, binding stored only on the issue);
  - the v8 `issues` table, with FK `ON DELETE SET NULL` and UNIQUE;
  - the new commands and events;
  - the drawer-toggle relay;
  - the `shell:openExternal` scheme allowlist and the navigation guard.

  Also add I19 to §7.
- [x] `TASKS.md`: new "Issues" block mirroring this plan, with `[ ]` markers grouped by layer.
- [x] `CHANGELOG.md` (Unreleased): the Issues feature and the schema bump to v8. Older builds refuse the upgraded DB, and a `.bak-v7` backup is written.

## Wave 2 (depends on Wave 1)

### Subject 6: Persistence (port, SQLite adapter, ids, fakes)
- [x] `src/ports/workspace-persistence.ts`: add `upsertIssue(issue: IssueSnapshot)` and `deleteIssue(id: IssueId)`. `load()` now returns `issues`.
- [x] `src/ports/id-generator.ts`: add `newIssueId()` and implement it in `src/adapters/id/uuid-id-generator.ts`.
- [x] `src/adapters/persistence/schema.ts`:
  - Set `SCHEMA_VERSION = 8` and extend the version-history comment.
  - Add the `issues` DDL to `SCHEMA_STATEMENTS` after `tasks`:
    - `id TEXT PK`, `name TEXT NOT NULL`, `description TEXT NOT NULL DEFAULT ''`, `project_path TEXT`;
    - `status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN (...))`;
    - `task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL`;
    - `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`.
  - Append the `{ toVersion: 8 }` migration with the identical `CREATE TABLE IF NOT EXISTS`. Migrations are append-only: never edit v1–v7.
- [x] `src/adapters/persistence/mappers.ts`: `IssueRow`, `issueToRow` and `rowToIssueSnapshot` (`NULL` → `undefined`).
- [x] `src/adapters/persistence/sqlite-store.ts`:
  - `load()` reads `SELECT * FROM issues ORDER BY created_at DESC`.
  - `upsertIssue` uses `INSERT ... ON CONFLICT(id) DO UPDATE`; also add `deleteIssue`.
  - Keep `upsertTask` as `ON CONFLICT DO UPDATE`. Never change it to `INSERT OR REPLACE`: REPLACE deletes the row, which fires `SET NULL` and silently unbinds the issue.
- [x] `src/application/use-cases/test-fakes.ts`:
  - `FakePersistence` gains `upsertedIssues`, `deletedIssues` and an `issues` map seeded from the initial snapshot.
  - Its `deleteTask` mirrors `SET NULL` on the fake issues.
  - The fake id generator gains `newIssueId()`.
- [x] Tests:
  - `src/adapters/persistence/mappers.test.ts`: issue row round trip, including a null project and task.
  - `src/adapters/persistence/sqlite-store.test.ts` (FakeDb): `user_version` is stamped 8; the v8 migration runs from version 7 and not on a fresh DB; `load` includes issues; upsert/delete SQL.
- [x] `scripts/probe-sqlite-store.cjs`, run against the real binary with `npm run probe:sqlite`:
  - Build a v7 DB on disk and reopen it: it migrates to v8 and the backup hook fires.
  - Issue round trip.
  - Deleting a task sets `issues.task_id` to NULL.
  - A second issue with the same `task_id` raises the UNIQUE error.
  - `upsertTask` on a bound task keeps `task_id`.

### Subject 7: Application contract (commands + domain events)
- [x] `src/ports/event-bus.ts`: add `IssueUpsertedEvent {type:'issueUpserted', issue: IssueSnapshot}` and `IssueDeletedEvent {type:'issueDeleted', issueId}` to `DomainEvent`.
- [x] `src/application/commands.ts`:
  - New inputs with branded ids: `CreateIssueInput`, `UpdateIssueInput`, `DeleteIssueInput`, `BindIssueInput`, `UnbindIssueInput`.
  - New `Command` union members: `createIssue`, `updateIssue`, `deleteIssue`, `bindIssue`, `unbindIssue`.
  - `issueId?: IssueId` on all three `CreateTaskInput` variants.
  - `alsoDeleteIssue?` on `DeleteTaskInput`.
  - `issuesKey?` on `SettingsPatch`.
  - `issueId?` on `CommandResult`.

### Subject 8: Renderer store + drawer view-state
- [x] `src/renderer/src/store/store.ts`, issue data:
  - Add `issues: Record<string, IssueDTO>` to `StoreData`/`initialData`.
  - `hydrateData` fills it from `state.issues`.
  - `reduceEvent` handles `issueUpserted` and `issueDeleted`. On delete, clear `selectedIssueId` if it was the deleted issue.
  - `reduceEvent` handles `issuesDrawerToggle` through the guarded toggle.
  - Default `issuesKey: 'Alt+Shift+KeyI'` in the default settings.
- [x] `src/renderer/src/store/store.ts`, drawer view-state (not persisted):
  - State: `issuesDrawerOpen`, `selectedIssueId`, `issueDraft` (new-issue mode flag), `issueEditDirty`, and `discardPrompt` (the pending action: `close` | `select:<id>` | `new`).
  - Actions: `toggleIssuesDrawer()`, `openIssuesDrawer(issueId?)`, `selectIssue(id)`, `startNewIssue()`, `setIssueEditDirty(bool)`, `confirmDiscard()`, `cancelDiscard()`.
  - While `issueEditDirty` is set, the close, select and new paths raise `discardPrompt` instead of acting.
  - Keep the drawer view-state when the store re-hydrates after the SettingsModal.
- [x] `src/renderer/src/store/store.ts`: selectors `issueForTask(data, taskId)` and `isIssueBoundElsewhere`.
- [x] New `src/renderer/src/store/group-issues.ts`: pure `groupIssuesByStatus(issues)`. Groups are in a fixed order (Todo, In progress, In review, Done), newest first (`createdAt` desc) within each group.
- [x] Tests:
  - Extend `src/renderer/src/store/store.test.ts`: hydrating issues; upsert/delete reducers; toggle/open/select; the dirty guard → discardPrompt → confirm/cancel; deleting the selected issue; re-hydrating keeps the drawer state.
  - New `src/renderer/src/store/group-issues.test.ts`.

### Subject 9: Preload bridge
- [x] `src/preload/index.ts`:
  - `issues.create/update/delete/bind/unbind` via `ipcRenderer.invoke` on the new channels.
  - `issues.toggleDrawer()` via `ipcRenderer.send(CHANNELS.issuesToggleDrawer)`.
  - `shell.openExternal(input)` via `invoke`.

### Subject 10: Presentational issue components + test bridge stub
- [x] New `src/renderer/src/components/IssueStatusIcon.tsx`:
  - Inline SwiftShader-safe glyphs: ○ todo, ◐ in_progress, ◉ in_review, ✓ done.
  - Colors come from `style/tokens.ts`. No icon library and no animation.
  - Exports `ISSUE_STATUS_LABELS` and `ISSUE_STATUS_ORDER`.
- [x] New `src/renderer/src/components/IssueMarkdown.tsx`:
  - `react-markdown` + `remark-gfm` with `skipHtml`.
  - Override `components.a`: `preventDefault`, then call `window.octopusAPI.shell.openExternal` only when `isSafeExternalUrl` passes. Other schemes do nothing.
  - Render `img` as its alt text, since the CSP `default-src 'self'` blocks remote images anyway.
- [x] New `src/renderer/src/components/BoundDeleteDialog.tsx`:
  - A modal using `overlayStyle`/`modalCardStyle`, with "Delete task only", "Delete issue only", "Delete both" and "Cancel".
  - Calls `onChoose('task'|'issue'|'both')` or `onCancel`. Esc cancels.
  - No backdrop blur or filter.
- [x] New `src/renderer/src/components/DiscardChangesPrompt.tsx`: a small "Discard unsaved changes?" confirm with Discard / Keep editing.
- [x] `src/renderer/src/test-support/stub-bridge.ts`: add the `issues` and `shell` groups, and `issues: []` to the default state.
- [x] Tests, all new:
  - `IssueStatusIcon.test.tsx`: the glyph and label for each status.
  - `IssueMarkdown.test.tsx`: GFM tables and task lists render; raw HTML is not rendered; clicking http/https links calls `openExternal`; clicking `javascript:`/`file:` links does not; no navigation happens.
  - `BoundDeleteDialog.test.tsx`.
  - `DiscardChangesPrompt.test.tsx`.

## Wave 3 (depends on Wave 2)

### Subject 11: Application — issue use cases + command loop
- [x] New `src/application/use-cases/create-issue.ts`:
  - Id from `deps.ids.newIssueId()`; timestamps from `deps.clock`.
  - Validate `projectPath` against `deps.settings.load().projects` (canonical match). An unknown path returns `{ok:false}`.
  - Persist, publish `issueUpserted`, and return `{ok:true, issueId}`.
- [x] New `src/application/use-cases/update-issue.ts`: patch name, description, project (`null` clears it) and status; validate the project; touch `updatedAt`; persist; publish `issueUpserted`.
- [x] New `src/application/use-cases/delete-issue.ts`: remove the issue from the workspace and persistence and publish `issueDeleted`. It is idempotent (a missing issue succeeds) and leaves the bound task untouched.
- [x] New `src/application/use-cases/bind-issue.ts`:
  - Reject a task that is not persisted (lifecycle `provisioning`, `provision_failed` or `none`), because the FK needs a tasks row.
  - Reject a task bound to another issue, with the error "already linked".
  - Call `workspace.bindIssue`, which replaces the old binding and applies todo→in_progress.
  - `upsertIssue` inside a transaction, then publish `issueUpserted`.
- [x] New `src/application/use-cases/unbind-issue.ts`: unbind, persist, and publish `issueUpserted`. Status is unchanged.
- [x] `src/application/command-loop.ts`: imports and `switch` cases for the 5 new kinds. `createIssue` returns its `CommandResult` (with `issueId`).
- [x] Tests:
  - New co-located `create-issue.test.ts`, `update-issue.test.ts`, `delete-issue.test.ts`, `bind-issue.test.ts` and `unbind-issue.test.ts`, using `test-fakes.ts`.
  - They cover: an empty name is rejected; an unknown project is rejected; binding a task bound elsewhere is rejected; rebinding replaces; todo→in_progress only from todo; unbind and delete keep the task.
  - Extend `src/application/command-loop.test.ts`: the new kinds are routed, and a domain error becomes `{ok:false}`.

### Subject 12: Application — task-flow integration
- [x] `src/application/use-cases/create-task.ts`, binding on Ready, in all three modes including `none`:
  - Inside the same persist transaction as `upsertTask`: if `input.issueId` is set and the issue still exists and is unbound, call `workspace.bindIssue` and `upsertIssue`. Publish `issueUpserted` after `taskCreated`.
  - If the issue is missing or bound elsewhere, create the task unbound and publish the existing `error` event as the toast: "Issue was linked to another task; task created without it".
  - A provisioning failure leaves the issue untouched.
  - The single-writer loop already serializes commands, so this check is defensive.
- [x] `src/application/use-cases/delete-task.ts`, in the final step 5 transaction only:
  - Before removing the task, resolve its issue with `workspace.issueForTask`.
  - With `alsoDeleteIssue`: `deleteIssue` + `removeIssue`, then publish `issueDeleted`.
  - Without it: persist the unbound issue (`upsertIssue`), then publish `issueUpserted`.
  - The dirty-gate return, a remove failure and a cancel all leave the issue unchanged.
- [x] `src/application/use-cases/remove-project.ts`: keep the existing block when tasks use the project. After `settings.save`, call `workspace.clearIssueProject(target.path)`, persist each changed issue in one transaction, and publish `issueUpserted` for each.
- [x] `src/application/queries/get-state.ts`: doc-only. `workspace` already carries `issues` via `Workspace.toSnapshot`; check that `AppStateView` exposes them.
- [x] Tests:
  - `create-task.test.ts`: binds on Ready (new/existing/none); stays unbound when provisioning fails; unbound plus an `error` event when the issue is already bound or missing; todo→in_progress.
  - `delete-task.test.ts`: `alsoDeleteIssue` deletes only on success; a `needsDirtyConfirm` return or a remove failure leaves the issue intact; a plain delete unbinds without changing the status; the force-forget path.
  - `remove-project.test.ts`: clears the project of matching issues (canonical match); still blocks when tasks exist; leaves unrelated issues untouched.
  - `get-state.test.ts`: issues are included.

### Subject 13: Main process — DTO mapping, IPC handlers, toggle relay, link safety
- [x] `src/main/dto-mappers.ts`:
  - `toIssueDTO`.
  - `toWorkspaceStateDTO` includes `issues`.
  - `toEventDTO` cases for `issueUpserted` and `issueDeleted`.
  - `toSettingsDTO` includes `issuesKey`.
- [x] `src/main/ipc-handlers.ts`, issue and task channels:
  - Handlers for the 5 issue channels, mapping each DTO to its command via `asIssueId`/`asTaskId`.
  - `taskCreate` must now map `issueId` through `asIssueId`. It currently forwards the input verbatim.
  - `taskDelete` forwards `alsoDeleteIssue`.
  - `ack()` copies `issueId`.
- [x] `src/main/ipc-handlers.ts`, other channels:
  - `shellOpenExternal`: check `isSafeExternalUrl`, call `shell.openExternal`, and return a boolean.
  - `ipcMain.on(issuesToggleDrawer)` calls the new `hooks.toggleIssuesDrawer`.
- [x] `src/main/composition-root.ts`: implement `toggleIssuesDrawer` in the `registerIpcHandlers` hooks:
  - Find the main `BrowserWindow` via `windowIds` → `MAIN_WINDOW_ID`.
  - `restore`/`show`/`focus`, then `webContents.invalidate()` (the same VDI repaint pattern as the `activeSessionChanged` raise).
  - Send `{type:'issuesDrawerToggle'}` via `windowRegistry.sendTo(MAIN_WINDOW_ID, ...)`.
- [x] `src/main/window.ts`, in `createWindow`:
  - `webContents.on('will-navigate')`: `preventDefault` for any URL other than the app's own renderer URL. Dev reload and HMR must keep working.
  - `setWindowOpenHandler`: open safe http/https URLs externally and always return `{action:'deny'}`.
  - Coordination: this breaks xterm `WebLinksAddon`'s default `window.open()` handler, so Subject 15 passes the addon an explicit handler.
- [x] Test: extend `src/main/dto-mappers.test.ts` for the issue DTO, state DTO, event mapping and `issuesKey`.

### Subject 14: Issues drawer components
- [x] New `src/renderer/src/components/IssuesDrawer.tsx`:
  - An absolutely positioned panel covering the session area. It is always mounted and slides via `transform: translateX(100%)` → `0`.
  - Animate only with a CSS `transform` transition: no backdrop, blur or filter.
  - When closed: `aria-hidden`/`inert`.
  - Split layout: `IssueList` on the left, `IssueDetail` on the right.
  - Esc closes the drawer through the guarded store action; while editing, it shows the discard prompt instead.
  - Focus moves into the drawer on open and back to the previous element on close, so xterm never receives the Esc.
  - Renders `DiscardChangesPrompt` from `discardPrompt`.
  - Takes the callback props `onCreateTaskFromIssue(issueId)` and `onDeleteBoundTask(taskId, alsoDeleteIssue)`, wired in Wave 4.
- [x] New `src/renderer/src/components/IssueList.tsx`:
  - Uses `groupIssuesByStatus`.
  - Collapsible group headers with counts; Done is collapsed by default (local state).
  - Rows show `IssueStatusIcon` plus the name; clicking selects via `selectIssue`.
  - "+ New Issue" calls `startNewIssue`.
- [x] New `src/renderer/src/components/IssueDetail.tsx`, view mode: the `IssueMarkdown` description, the project and the bound task's name. A status `<select>` works outside edit mode (`issues.update({status})`).
- [x] `IssueDetail.tsx`, edit and draft modes:
  - Edit mode: name (required), a description textarea, and a project `<select>` filled from `projects.list()` with a "No project" option.
  - Explicit Save/Cancel; dirty tracking calls `setIssueEditDirty`.
  - Draft mode: Save calls `issues.create`, then `selectIssue(ack.issueId)`. Cancel discards.
- [x] `IssueDetail.tsx`, buttons:
  - Delete: an unbound issue gets a simple confirm, then `issues.delete`. A bound issue gets `BoundDeleteDialog`: "issue" calls `issues.delete`; "task" and "both" call `onDeleteBoundTask`.
  - Create task calls `onCreateTaskFromIssue`. It is disabled when the issue is already bound.
  - Link task opens `LinkTaskPicker`.
  - Disconnect calls `issues.unbind`. It is shown only when bound.
- [x] New `src/renderer/src/components/LinkTaskPicker.tsx`:
  - Lists the store's tasks.
  - Tasks bound to a different issue are grayed with "already linked". Tasks that are not persisted (provisioning or failed) are disabled.
  - Picking a task calls `issues.bind`, which replaces an existing binding without a prompt.
- [x] Tests, all new:
  - `IssuesDrawer.test.tsx`: the open/closed transform; Esc closes; Esc while dirty prompts.
  - `IssueList.test.tsx`: grouping, order, Done collapsed, toggle.
  - `IssueDetail.test.tsx`: Edit/Save/Cancel; draft create selects the new id; name is required; status changes outside edit mode; the discard prompt on selecting another issue; the bound versus unbound delete dialog; button visibility.
  - `LinkTaskPicker.test.tsx`: graying and the bind call.

### Subject 15: Issues keybinding (UI)
- [x] `src/renderer/src/components/SettingsModal.tsx`: add `'issuesKey'` to `ChordKey` and `CHORD_FIELDS` (label "Toggle Issues", default `'Alt+Shift+KeyI'`) and to the save payload. The existing collision and modifier checks then apply to it.
- [x] `src/renderer/src/hooks/useKeyboardShortcuts.ts`:
  - Match `issuesKey`. In the main window, call `store.toggleIssuesDrawer()`. In a secondary window (`store.windowRole === 'secondary'`), call `window.octopusAPI.issues.toggleDrawer()`.
  - Update the header doc comment.
- [x] `src/renderer/src/terminal/TerminalPane.tsx`:
  - Add `issuesKey` to the `configurable` pass-through list. Alt+Shift isn't covered by the blanket Ctrl+Shift drop, so without this the terminal would swallow it.
  - Construct `new WebLinksAddon((_e, uri) => isSafeExternalUrl(uri) && void window.octopusAPI.shell.openExternal({url: uri}))`, so terminal links still work under Subject 13's `setWindowOpenHandler` deny.
  - No change is needed in `src/renderer/src/keybindings/chords.ts`: `RESERVED_CHORDS` stays empty.
- [x] Tests:
  - `SettingsModal.test.tsx`: the new row, its default, rebinding, collision.
  - `useKeyboardShortcuts.test.tsx`: in the main window the shortcut toggles the store; in a secondary window it calls `issues.toggleDrawer`.
  - `TerminalPane.test.tsx`: `issuesKey` is not forwarded to the PTY.

### Subject 16: Bound-task delete flow
- [x] `src/renderer/src/components/DeleteTaskConfirm.tsx`:
  - New optional props `preset?: 'task'|'both'` (skips the choice step) and `onDone?`.
  - When the task is bound (`issueForTask`) and there is no preset, the first step is `BoundDeleteDialog`.
  - "issue" calls `issues.delete` and closes; the task stays.
  - "task" and "both" call `tasks.delete({taskId, alsoDeleteIssue})` directly; the choice counts as the confirmation.
  - On `needsDirtyConfirm`, the existing dirty step appears. It re-dispatches with `confirmedDirty` and the same `alsoDeleteIssue`. Cancelling it deletes nothing.
  - Keep Force-forget for stale or failed bound tasks, carrying `alsoDeleteIssue`.
  - The unbound flow is unchanged.
- [x] Test: extend `DeleteTaskConfirm.test.tsx`: the unbound flow is unchanged; a bound task shows the 4 choices; each choice sends the right payload; the dirty step keeps `alsoDeleteIssue`; cancelling the dirty step sends nothing further; a preset skips the choice.

### Subject 17: New-Task modal — issue picker + prefill
- [x] `src/renderer/src/components/NewTaskModal.tsx`, issue picker:
  - New optional prop `fromIssueId?: string`.
  - An "Associated issue" `<select>` on all 3 tabs. It lists issues from the store that are not done, with `IssueStatusIcon`. Issues bound to a task are disabled with "already linked".
  - Picking an issue:
    - fills an empty name;
    - fills the branch through the existing underscore `taskNameToBranchSlug` logic, unless the user has edited the branch;
    - selects the issue's project if none is picked (exact path match against `projects.list()`).
  - Every `tasks.create` input includes `issueId`.
- [x] `NewTaskModal.tsx`, prefill mode (`fromIssueId` set):
  - The issue picker is locked, name = the issue name, and tab = `'new'`.
  - If the issue has a project that is in the list, select it and derive the new branch from the name. Otherwise leave the project unselected.
  - The prefill runs after the projects load.
- [x] Test: extend `NewTaskModal.test.tsx`:
  - The picker appears on all tabs; done issues are excluded; bound issues are disabled.
  - Name/branch autofill only when empty; project autoselect only when none is picked.
  - Prefill/locked mode; `issueId` is in the payload; an issue with no project leaves the project unpicked.

## Wave 4 (depends on Wave 3)

### Subject 18: Main-window integration
- [x] `src/renderer/src/App.tsx` (`MainWindowApp` only):
  - Wrap `TaskWorkspace` and `IssuesDrawer` in a `position:relative; flex:1; display:flex` container, so the drawer covers only the session area and not the ProgressPanel.
  - Replace `showNewTask` with `newTaskFrom: {issueId?} | null`.
  - Wire `onCreateTaskFromIssue` to open `NewTaskModal fromIssueId`, and `onDeleteBoundTask` to render `DeleteTaskConfirm` with a `preset`.
  - Secondary windows get no drawer.
- [x] `src/renderer/src/components/ProgressPanel.tsx`: an "Issues" button pinned to the bottom left, below the task list. `aria-pressed` reflects whether the drawer is open; clicking calls `toggleIssuesDrawer()`.
- [x] `src/renderer/src/components/TaskListItem.tsx`:
  - A bound task shows the issue's `IssueStatusIcon`, with `title` = the issue name. Read the issue via the store selector.
  - Clicking the icon calls `stopPropagation` (so the task isn't activated) and `openIssuesDrawer(issueId)`.
  - `onPointerDown` also calls `stopPropagation`, so dnd-kit doesn't start a drag.
- [x] `src/renderer/src/components/IssuesDrawer.tsx`: finish wiring the callback props from App.
- [x] Tests:
  - `ProgressPanel.test.tsx`: the Issues button toggles the drawer; `aria-pressed`.
  - New `TaskListItem.test.tsx`: the icon shows only when bound; the hover title; clicking opens the drawer on that issue without switching task.
  - `App.test.tsx`: the drawer is mounted only in the main window; "Create task" from an issue opens the prefilled modal; the `issuesDrawerToggle` event toggles the drawer.

## Testing

- [x] Real-binary persistence: `npm run probe:sqlite` with the Subject 6 probe additions. The unit tests use FakeDb, so the real SQL is covered only here:
  - v7→v8 migration on an existing DB, with a backup;
  - round trip;
  - FK `SET NULL` on task delete;
  - UNIQUE `task_id`;
  - `upsertTask` keeps the binding.
- [x] New `test/integration/issues.integration.test.ts`, running a real `CommandLoop` over the `test-fakes` deps:
  - createIssue → createTask with `issueId` → the issue is bound and `in_progress`.
  - deleteTask with dirty confirm and `alsoDeleteIssue` → both are gone.
  - removeProject clears the issue's project.
  - bind is rejected when the task is bound elsewhere.
- [x] Edge cases:
  - Binding an issue whose status is not `todo` (e.g. `in_review`) leaves it unchanged.
  - Rebinding an issue frees its old task for other issues.
  - Deleting an unbound issue.
  - Deleting the selected issue from another path clears the selection.
  - An issue whose project was removed shows "No project".
  - A restart rehydrates issues and bindings.
- [x] Security:
  - `shell:openExternal` rejects `file:`, `javascript:`, `data:` and malformed URLs, in main as well as in the renderer.
  - `will-navigate` is blocked and `window.open` is denied.
  - Terminal web links still open in the system browser.
- [x] Whole-tree gate after Wave 4: `npm run typecheck`, `npm run lint` (boundaries: the renderer imports no domain/ports, and application imports no shared), `npm run test`, `npm run format:check`, `npm run build`.
- [ ] Manual smoke in `npm run dev`:
  - The Issues button and Alt+Shift+I toggle the slide-in drawer, with a smooth animation and no blur.
  - Esc closes the drawer; Esc while editing prompts to discard.
  - Create, edit, cancel and status change.
  - Markdown renders, and links open the system browser.
  - Connect and disconnect; graying in the pickers.
  - Create task from issue: the name, branch and project are prefilled, and the issue is bound once the task is Ready.
  - The New-Task picker on all tabs.
  - The bound-delete dialogs from the task side and the issue side, including the dirty worktree step.
  - The task row icon, its hover title and click.
  - The shortcut from a secondary window raises the main window and toggles the drawer.
  - Rebinding the shortcut in Settings.
  - Removing a project that issues use.
  - A restart: issues persist, and the drawer starts closed.

## Acceptance Criteria
- Issues persist in SQLite schema v8 and survive restart:
  - a required name, a markdown description, an optional configured project;
  - a status of todo, in_progress, in_review or done, each with an inline glyph.

  An older build refuses the v8 DB, and upgrading writes a `.bak-v7` backup.
- An issue binds to at most one task, and a task to at most one issue. The binding is stored only on `issues.task_id`.
- Every bind path (connect, create from issue, the New-Task picker) moves todo→in_progress in the same command. Unbind, disconnect and task deletion never change the status.
- createTask binds only once the task reaches Ready:
  - if provisioning fails, the issue stays unbound;
  - if the issue was bound elsewhere in the meantime, the task is created unbound and a toast explains why.
- Deleting a bound task or a bound issue offers "Delete task only", "Delete issue only", "Delete both" and "Cancel":
  - "Delete both" removes the issue only if the task delete succeeds, including after the dirty-worktree step;
  - deleting an unbound issue shows a simple confirm.
- removeProject succeeds when only issues reference the project, and it clears their project. Tasks still block removal.
- The drawer:
  - toggles from the ProgressPanel "Issues" button, Esc, and the configurable `issuesKey` (default Alt+Shift+I);
  - slides in from the right using only a transform, and covers only the session area;
  - exists only in the main window. The shortcut also works from secondary windows: it raises and focuses the main window. Drawer state is not persisted.
- The drawer's left side lists issues grouped by status (collapsible, Done collapsed, newest first). The right side shows the issue:
  - Edit, Save and Cancel; a status dropdown that works outside edit mode;
  - Delete, Create task, Link task and Disconnect.

  Unsaved edits prompt before switching issue, closing the drawer or pressing Esc.
- Markdown renders with GFM and with raw HTML disabled. Only http/https links open, in the system browser, and the app window never navigates away.
- The New-Task modal has an "Associated issue" picker on all three tabs:
  - It lists issues that are not done; bound issues are grayed out.
  - Picking one autofills an empty name and branch, and a project if none is picked.

  Create-from-issue opens the "From New Worktree" tab prefilled, with the issue locked.
- A bound task's row shows the issue's status icon, with the issue name on hover. Clicking the icon opens the drawer on that issue.
- `npm run typecheck`, `npm run lint` (including boundaries), `npm run test` and `npm run probe:sqlite` all pass. PRD.md, DESIGN.md (including I19), TASKS.md and CHANGELOG.md are updated.
