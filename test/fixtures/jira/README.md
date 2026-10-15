# Jira gateway fixtures

These are **verbatim** HTTP response bodies (the full gateway envelope — `content`,
`structuredContent`, `isError`) captured once from the real LiteLLM MCP gateway, then
scrubbed of personal data. Adapter tests serve them through a fake `fetch`; nothing in
`src/` or any test calls the live gateway.

## Endpoint and wire shape

- `POST https://litellm.israel.final/mcp-rest/tools/call`
- Body: `{"name": "jira_<tool>", "arguments": {...}, "server_id": "628a8d3ece8c06bc50523679ea834304"}`
- The wire tool name carries the server alias prefix twice: calling the upstream tool
  `jira_search` means `name: "jira_jira_search"`. Confirmed wire names used here:
  `jira_jira_search`, `jira_jira_get_issue`, `jira_jira_get_all_projects`.
- Every response has `structuredContent: null` and text-only `content: [{type: "text", text: "..."}]`.
  `isError` was `false` even for an unknown project or an unknown issue key — only a
  genuine input-validation error set it `true` (see `is-error.json`).

## Capture method

Captured with a temporary, uncommitted script (`/tmp/jira-fixture-capture/capture.py`,
run via `python3 -I`, deleted after use) that POSTs directly to the gateway and dumps
the parsed JSON response verbatim. It borrowed only the auth-key lookup from the
reference client at `/home/udim/bin/jira` (`LITELLM_KEY` env var, else the
`x-litellm-api-key` already embedded in `~/.claude.json`) — the reference client itself
was not modified or copied into the repo, and its own `raw`/`call` helper joins
`content[].text` instead of returning the full envelope, so it could not be used
directly for fixture capture.

## Files and arguments

| File | Tool | Arguments | Covers |
|---|---|---|---|
| `search-page1.json` | `jira_search` | `{"project":"TM","limit":5,"offset":0}` | First page: `Found N total issues in project TM (showing 1-5 of 820)` header, the "⚠️ N more tickets available..." hint, 5 bullets. Limit 5 (not 50) was used to keep the fixture small — the format is identical at any limit. |
| `search-page2.json` | `jira_search` | `{"project":"TM","limit":5,"offset":5}` | Next page (`offset=5`, "showing 6-10 of 820"). Includes `TM-2608`, the known dod-bearing issue, as a search bullet. |
| `search-no-issues.json` | `jira_search` | `{"project":"ZZZNOPE","limit":5,"offset":0}` | Unknown project: text is exactly `No issues found with filters: project=ZZZNOPE`, `isError: false`. |
| `get-issue-batch.json` | `jira_get_issue` | `{"ticket_id":"TM-2608,TM-2616,TM-2614,TM-2611,TM-2609"}` | 5 issues, `---`-separated, incl. `TM-2608` (dod `"CI passes"`, matches the known fixture data). Sprint variety: `TM-2608` closed+active (two-element array), `TM-2616` active, `TM-2611`/`TM-2609` future, `TM-2614` **null** Sprint. |
| `get-issue-sprints.json` | `jira_get_issue` | `{"ticket_id":"TM-2616,TM-2611,TM-2103,TM-2614,HD-10966"}` | Sprint-state matrix: `TM-2616` active, `TM-2611` future, `TM-2103` closed, `TM-2614` null Sprint (non-null dod), `HD-10966` **both** null Sprint and **null dod** (`"dod": null` — the key exists; it is `null`, not absent). `dod: null` was only found on `HD` (helpdesk) issues in this dataset — `TM`/`BUZZ` sampled issues all had a non-empty `dod`. |
| `projects.json` | `jira_get_all_projects` | `{}` | `Found 102 projects:` header + `  • KEY: N tickets` lines, incl. `TM: 820 tickets` and `BUZZ: 878 tickets`. |
| `is-error.json` | `jira_get_issue` | `{}` (missing required `ticket_id`) | A **real** `isError: true` envelope: `Input validation error: 'ticket_id' is a required property`. Not synthetic — the gateway returned this directly. |

All `get_issue` calls stayed within the documented 10-comma-separated-key limit.

## Exact text line formats (post-scrub, verbatim)

`jira_search` bullet (one issue, from `search-page1.json`):

```
• [TM] TM-2616 - Update Covar Grafana Alerts and make new
  Status: Done, Priority: Low, Type: Task
  Assignee: Dave Example, Reporter: Dave Example
  Dest. Team: RD_TRD Team
  Created: 2026-10-07T09:32:14.483+0300
```

Line order/prefixes: `• [PROJ] KEY - Summary`, then `  Status: <s>, Priority: <p>, Type: <t>`,
then `  Assignee: <name|Unassigned>, Reporter: <name>`, then an optional
`  Dest. Team: <team>` line (present on `TM`/`BUZZ`-style project issues, absent on some
others — not mentioned in the design doc, but present on every captured line here), then
`  Created: <ISO 8601 with offset>`. Some projects/issue types add further optional lines
before `Created` (e.g. `Production Impact:`, `Final Group:`, `Down Time:` were observed on
`PI` incidents during capture, not included in these fixtures) — adapters should parse by
line *prefix*, not fixed position.

Header line: `Found <N> total issues in project <PROJ> (showing <a>-<b> of <N>)`, optionally
followed by `⚠️ <N> more tickets available. Use offset=<next> to get the next batch.` when
there's a next page.

`jira_get_issue` block header/separator (from `get-issue-batch.json`):

```
Issue TM-2608 details:
{
  "Status category changed": "2026-10-01T15:48:34.766+0300",
  ...
  "Assignee": {
    "self": "https://jira-final-il.atlassian.net/rest/api/3/user?accountId=account-0001",
    "accountId": "account-0001",
    "emailAddress": "user@example.invalid",
    "avatarUrls": { "48x48": "https://avatar.example.invalid/x.png", ... },
    "displayName": "Alice Example",
    "active": true,
    "timeZone": "Asia/Jerusalem",
    "accountType": "atlassian"
  },
  ...
  "dod": { "type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "CI passes"}]}] },
  "Sprint": [ { "id": 5472, "name": "TM_Q326_Sprint7_20.09", "state": "closed", ... }, { "id": 6572, "name": "TM_Q426_Sprint1_04.10", "state": "active", ... } ],
  ...
}
---
Issue TM-2616 details:
{ ... }
---
```

Notable: the raw JSON per issue is the **entire** Jira field set (60-80+ keys — custom
fields, worklog totals, approvals, etc.), not just the subset the design doc names
(Summary, Description, dod, Sprint, Status, Priority, Type, Assignee, Reporter, Created,
Project). The field is literally `"Issue Type"`, not `"Type"` (the search-text bullets use
`Type:`, the JSON uses `"Issue Type"`). Each block ends with a `---` line, including after
the last issue in a batch (confirmed from these captures).

## Scrubbing rule (applied, and must be preserved by any future re-capture)

1. Every real email (`<name>@final.co.il`) → the single placeholder `user@example.invalid`.
2. Every real Jira `accountId` (both the plain field and the URL-encoded copy embedded in
   `self` links, e.g. `...user?accountId=712020%3Af1c5...`) → a stable `account-000N`
   placeholder, one N per distinct identity, reused across every fixture file (so the same
   person has the same `account-000N` in `search-page2.json` and `get-issue-batch.json`).
3. Every real `avatarUrls`/gravatar URL → the single placeholder
   `https://avatar.example.invalid/x.png`. (Non-personal avatar URLs — Jira issue-type and
   project icon URLs under `.../avatar/view/type/...` — are not personal data and were left
   as-is.)
4. Every real person `displayName` → a generic placeholder (`Alice Example`, `Bob Example`,
   …), applied **consistently in both the search-text bullets and the `get_issue` JSON**, so
   assignee/reporter matching still works within and across fixtures. Non-person identities
   (`Automation for Jira`, `Unassigned`, `MD OnCall`) were left unchanged — they are system/
   role labels, not people, though the bot's `accountId` was still placeholder-mapped.
5. Every phone number in free-text fields (e.g. an email signature pasted into an `HD`
   description: `+972-(0)52-…`, extensions `#NNN`) → `+000-0-0000000`. Free-text
   descriptions can carry personal contact details, so grep them on every re-capture.
6. The scrub never touches JSON *structure* — only string leaf values — so the JSON embedded
   in the `details:` text blocks still parses after scrubbing (verified programmatically for
   every file during capture).
7. The real Jira hostname (`jira-final-il.atlassian.net`) was **not** scrubbed — it's not
   personal data, just the instance URL, and it's useful context for the adapter.

Capture + scrub were done with temporary scripts under `/tmp/jira-fixture-capture/`
(`capture.py`, `scrub.py`), run with `python3 -I`, and deleted immediately after. No API
key, `Authorization` header, or `Bearer` token appears in any fixture (grepped for `sk-`,
`Bearer`, `@`, `avatar`, `accountId` after scrubbing — the only `@` hits are
`user@example.invalid`, the only `avatar` hits are the placeholder URL plus the non-personal
issue-type/project icon URLs, and the only `account` hits are the `account-000N`
placeholders).
