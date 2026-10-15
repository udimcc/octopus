# Jira Issue Import — Design

**Date:** 2026-10-14
**Goal:** Let the user manually fetch Jira issues (read-only) and import selected ones as Octopus Issues, with duplicate and conflict detection on re-fetch.

## Context and constraints

- Octopus runs on the internal network; Jira lives on the external one. The only route is the **LiteLLM MCP gateway** (`https://litellm.israel.final/mcp-rest/tools/call`), which proxies to an upstream "JiraSSE" MCP server holding the Jira credentials. `/home/udim/bin/jira` is a Python reference client only — Octopus must not depend on it or its path.
- Gateway data is a **cache refreshed every few hours**, not live Jira. The UI says so.
- Fetching is **manual only** — never automatic or on a timer.
- Verified gateway behavior (2026-10-14):
  - Tools: `jira_search` (project, assignee, days, limit, offset, …), `jira_get_issue` (up to 10 comma-separated keys), `jira_get_all_projects`. There is **no sprint tool and no status filter**.
  - On the wire, the tool name carries the server alias prefix (`jira_jira_search`), as in the reference client.
  - **All responses are text-only.** `structuredContent` is null, and `isError` is false even for an unknown project, which returns the text "No issues found with filters: …".
  - Search text has a "Found N total issues …" header, then one `• [PROJ] KEY - Summary` bullet per issue followed by preview lines.
  - Issue details come as `Issue KEY details:` + JSON + a `---` separator per issue. The JSON includes Summary, Description (ADF), `dod` (ADF, the Definition of Done custom field), Sprint (array of id/name/state), Status, Priority, Type, Assignee, Reporter, Created and Project.
  - Node 20's global `fetch` reaches the gateway (TLS OK).
  - Deriving sprints from a project's 30 most recent issues takes about 0.3s and found the active, future and closed sprints for every project tried.
- DESIGN invariant **I16 (never persist secrets)**: the API key must not go into settings.json or the DB.

## Product behavior

### Entry point
- A **"Fetch from Jira"** button in the Issues drawer header, next to "+ New Issue", opens the **Jira Import** modal.

### Filters
- **Project** is a dropdown from the gateway's project list. It is required unless an Issue key is given.
- **Assignee** is free text, matched as a partial name.
- **Issue key** fetches exactly that issue and ignores the other filters.
- **Created in last N days** is a number.
- **Sprint** is loaded when a project is chosen:
  - When sprints are found, a dropdown lists **None** (the default), then the active sprint(s), then future, then closed.
  - When the project has no sprints, it falls back to free-text sprint-name matching.
- The last-used filters are remembered and pre-filled the next time the modal opens.
- A hint reads "Jira data refreshes every few hours".

### Results
- **Fetch** loads results in pages of 50, with **Load more**.
- Each row shows a checkbox, the key, the summary, and the Jira status, type and assignee. These are informational only; the Jira status is never imported.
- Clicking a row opens a read-only **detail pane**: key, summary, status, priority, type, assignee, reporter, created, sprint, and the Description and DOD rendered as markdown.
- The footer has **Select all** (it selects only importable rows), an "N selected" count, and **Import**.

### Duplicates and conflicts
Each fetched issue is matched against existing Octopus issues by its stored Jira key:

| State | Rule | Display |
|---|---|---|
| New | No Octopus issue has this key | Selectable |
| Duplicate | Same key, and identical name and description | Grayed out, not selectable, label "Duplicated by <Octopus issue name>" |
| Conflict | Same key, but the name or description differs | Grayed out, not selectable, label "Conflicts with <Octopus issue name>" |

- Conflicts are **view-only**; there is no overwrite.
- Deleting the Octopus issue frees its key, so the Jira issue is New again.

### Imported issue shape
- **Name:** `KEY: Summary`, e.g. `TM-2608: Broken CI - creds doesnt getting through`.
- **Description:** the Jira Description as markdown, followed by a "Definition of Done" section with the DOD content. The DOD section is added only when DOD is non-empty.
- **Status:** Todo. The Jira status is never imported.
- **Project:** none; the user sets it later per issue.
- **Source:** Jira. This is a new field, read-only, that the user can never edit; existing and manually created issues are "Local".
- Name and description stay editable. A local edit makes the issue show as a Conflict on the next fetch.
- An import is all-or-nothing: either every selected New issue is created, or none is.

### Display in the Issues drawer
- A small **"Jira" badge** on imported rows in the issue list.
- A read-only **"Source: Jira (KEY)"** or **"Source: Local"** line in the issue detail.

### API key and errors
- A "Jira API key" password field in Settings. The key is never shown again after saving; it can be cleared.
- The modal has distinct states for:
  - **No key set**, with an Open Settings button.
  - **Key rejected**, with an Open Settings button.
  - **Gateway unreachable**, with a Retry button.

## Architecture

The feature follows the existing hexagonal layout, and the dependency rule stays machine-enforced.

- **Domain**
  - `Issue` gains a read-only `source` (Local or Jira) and an optional `jiraKey`. A Jira-sourced issue must have a key, and a key implies Jira as the source.
  - A new pure module holds the import rules:
    - Composing an issue's name and description from Jira fields.
    - Classifying a fetched issue as New, Duplicate or Conflict against the existing issues.
    - Ordering sprints and matching the sprint filter.
  - The composed name follows the same trimming rules as `Issue.create`, so a fresh import is never misread as a Conflict.
- **Ports**
  - New `JiraIssueSource`: list projects, list sprints, search (cursor-paged), and get issues by keys.
  - The existing shape-only `CredentialsProvider` gets its first implementation, gaining set/has alongside resolve.
- **Adapters**
  - **LiteLLM Jira source:** HTTP to the gateway, parses the text formats above, fetches details in batches of 10.
    - Sprint filtering happens in the app after the details are loaded, scanning whole search pages until it has 50 matches.
    - Errors are mapped to: no key, unauthorized, unreachable, gateway error.
  - **ADF-to-markdown converter:** pure and deterministic. It covers paragraphs, headings, lists, code blocks, line breaks, and bold/italic/code/link marks. Unknown nodes fall back to their text.
  - **Credentials adapter:** Electron `safeStorage`-encrypted file in a `credentials/` folder under the data dir, mode 0600.
    - `safeStorage` is touched only on first use, because the app's setup runs before Electron is ready.
- **Persistence**
  - Schema v10 adds a `source` column (default local, with a check constraint) and a `jira_key` column with a unique index.
  - The migration guards its column additions, because the base table DDL already runs before migrations on older DBs.
  - Migrations stay append-only; upgrading writes the usual pre-migration backup.
- **Application**
  - **Fetching is a query.** It bypasses the single-writer command loop: main calls the port, then classifies the results against the current issues.
  - **Import is one command.** Main fetches the selected issues' details outside the loop. Inside the loop, the use case re-classifies them (it never trusts the renderer), creates all New issues in one transaction, then updates memory and publishes the events.
- **IPC / shared**
  - New `jira` (projects, sprints, search, import) and `credentials` (set key, has key) groups.
  - Results carry a typed error envelope so error kinds survive IPC.
  - The issue DTO gains `source` and `jiraKey`. Settings gain `jira.lastFilters`, which is non-secret.
  - The key itself never travels back to the renderer.
- **Main:** the composition root wires the two new adapters, and the IPC handlers validate filters and keys at the edge.
- **Renderer**
  - A new Jira Import modal that follows the shared overlay contract. It is portaled to the body because it opens from inside the drawer, and it is registered in the drawer's top-modal list.
  - The drawer gets the button and the badge, and the issue detail gets the source line.
  - The Settings key field is added, and the Settings modal's open state moves into the store so the Jira modal can open Settings. The Jira modal closes itself first, since it paints above Settings.

## Testing scope

- **Fixtures:** captured from real gateway responses with emails, avatar URLs and account IDs scrubbed. No test calls the live gateway.
- **Domain:**
  - Compose and classify: new; duplicate; conflict on a name or description difference; a locally edited import becomes a conflict; a deleted import becomes new again.
  - Composing is stable: a fresh import re-fetches as Duplicate.
  - The Issue source/key invariant.
- **Adapters:**
  - The ADF converter: every node type, unknown nodes, null and malformed input.
  - The Jira source: request shape, parsing of each text format, batching, every error kind, sprint ordering and filtering across pages, and the key lookup.
  - Migrations v7→v10 and v9→v10, with the unique and check constraints enforced.
  - Credentials: the stored file is encrypted, has mode 0600, and the key is never leaked.
- **Application:** import creates the right issues, skips duplicates and conflicts even when they are requested, rolls back completely on failure, and publishes one event per created issue.
- **Main:** input validation, error mapping, and the DTO mapping seam.
- **Renderer:**
  - The modal: prefilled filters, row states and labels, Select all picks only New rows, the detail pane, Import, Load more, each error state, and no key leaks to the window-level shortcuts.
  - Elsewhere: the Jira badge, the source line, and the Settings field never showing the key.
- **Integration:** import → reload → re-fetch shows Duplicate; a local rename shows Conflict; deleting the issue shows New.

## Documentation to update during implementation

- **DESIGN.md:** a new "Jira import" section, and an I16 note that `CredentialsProvider` is now implemented for the Jira key (encrypted at rest).
- **PRD.md (Issues):** the Source field and an "Importing from Jira" section.
- **TASKS.md** and **CHANGELOG.md:** the feature and the schema v10 upgrade note.
