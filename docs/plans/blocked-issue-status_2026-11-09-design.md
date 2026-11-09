# Blocked Issue Status — Design

**Date:** 2026-11-09
**Branch:** `blocked_status`

## Motivation

A user sometimes waits on something external before an issue can continue. They need a status
that says so ("Blocked") and a place to document *why* the issue is blocked.

## Product decisions

| Topic | Decision |
|---|---|
| Status order | Todo → In progress → **Blocked** → In review → Done (drives List groups, Board columns, status dropdown, pickers) |
| Icon | Red "no entry" circle (circle with a horizontal bar), error/red color, static |
| Where reasons show | Issue view only — List rows and Board cards show just the status icon |
| View placement | Below the description, separated by a divider, under a "Blocked reasons" heading |
| Edit placement | Textarea directly after Description (Name, Description, Blocked reasons, Project) |
| Rendering | Markdown, same renderer and look as the description |
| Empty + Blocked (View) | Section shown with a muted "No reason given" placeholder |
| Visibility rule | Section/field present **only while status is Blocked** (View and Edit) |
| Editing | Only via Edit, following every existing issue-edit behavior (Save/Cancel, dirty guard, busy/error) |
| On setting Blocked | Nothing extra — status changes, the empty section appears; user clicks Edit to fill it |
| Retention | Reasons are never cleared automatically; switching away keeps them (hidden), switching back shows them again. Only the user editing them to empty clears them |
| Status change mid-edit (Board drag) | The field hides/shows live; its unsaved draft is kept, still counts as unsaved (discard prompt), and is saved on Save |
| Board | A fifth "Blocked" column; drag in/out behaves like any other column |
| New-issue draft | No blocked reasons field (new issues start in Todo) |

## Approach (chosen: Issue field)

Blocked reasons are a plain string field on the `Issue` aggregate, modeled exactly like
`description`. Alternatives rejected:

- **Separate table + own IPC:** Save would need two calls (non-atomic) plus a new event,
  store slice and hydrate path.
- **Embedded in the description:** breaks Jira re-import classification, which compares the
  stored description byte-for-byte (every blocked Jira issue would become a Conflict), and
  leaks into the List preview.

## Architecture

- **Domain:** `IssueStatus` gains `Blocked = 'blocked'`; `Issue` gains `blockedReasons`
  (default empty) with its own setter. It is independent of status — no status transition
  touches it. The Todo → In progress binding automation is unaffected.
- **Persistence (schema v12):** the `issues.status` column has a SQLite CHECK constraint,
  which cannot be altered, so v12 rebuilds the table (create new, copy, drop, rename) —
  the same pattern as the v11 `windows` rebuild. The rebuild admits `'blocked'` and adds
  `blocked_reasons TEXT NOT NULL DEFAULT ''`. It is guarded on the column's existence so a
  pre-Issues DB (which bootstraps the new shape directly) skips it. Nothing references
  `issues` by foreign key, so the drop is safe with foreign keys on. The Jira-key unique
  index dropped with the old table is re-created by `SqliteStore.create` after migrations.
  Forward-only/append-only migration rules apply; older builds refuse a v12 DB.
- **Wire contract:** `IssueStatusDTO` gains `'blocked'`, `IssueDTO` carries
  `blockedReasons`, `UpdateIssueInput` accepts an optional `blockedReasons`.
- **Main:** the `issues.update` handler rejects a non-string `blockedReasons`.
- **Application:** `updateIssue` applies the optional patch inside its existing
  capture-before / restore-after rollback; a status-only patch leaves reasons untouched.
- **Data flow:** Edit → Save sends one `issues.update` (name, description, blocked reasons,
  project) → validation → `updateIssue` → `upsertIssue` → `issueUpserted` to every window.
  Status changes (dropdown / Board drag) send status only.
- **Renderer:** the display rule lives in `IssueDetail` (show iff status is Blocked). The
  canonical status table (`store/issue-status.ts`) and the icon tables gain the new entry;
  List, Board and pickers derive from the canonical order.

## Unaffected

- Jira import: the Jira status is never imported, and classification compares only
  name/description.
- The new-issue draft form and creation input.

## Testing strategy

- Update existing tests that enumerate four statuses (domain, icon, List, group-issues,
  Board, mappers, DTO mappers, sqlite-store).
- Domain: parse, snapshot round-trip, status changes keep reasons.
- Migration: fake-DB statement tests (v11 rebuilds, fresh/v12/pre-Issues skip, index
  re-created, fresh and v12 DDL match) plus a real-binary probe migrating a v11 DB with rows
  in every status, a task-bound issue and a Jira issue — all data, constraints and the
  unique index survive; `'blocked'` is accepted, an unknown status rejected.
- Use case: patch, rollback on persistence failure, status-only patch.
- IPC: non-string rejected, `'blocked'` accepted.
- IssueDetail: view shown/placeholder/hidden; edit field show/hide on mid-edit status change;
  hidden draft is dirty; Save sends the field; Cancel restores; draft form has no field.
- Board: Blocked column exists; a drop dispatches the Blocked status.
- Jira re-import of a blocked issue with reasons stays Unchanged; integration round-trip.
- Edge cases: whitespace-only reasons stored as given (like description).
