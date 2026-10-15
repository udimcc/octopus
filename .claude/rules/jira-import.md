# Rule: Jira import invariants (DESIGN §13.7)

Applies to `src/adapters/jira/`, `src/adapters/credentials/`, `src/domain/jira-import.ts`,
the `jira`/`credentials` IPC groups and `JiraImportModal.tsx`.

- **Converter output is stored data.** Classification compares an imported issue's name and
  description with a fresh compose byte for byte. Any change to `adf-to-markdown.ts` or
  `composeJiraIssue` output (whitespace, mark order, list indent, fences) turns every
  unedited imported issue into a **Conflict**. Treat such a change as a data migration:
  call it out and get the user's approval first.
- **Never call the live gateway in tests.** Serve `test/fixtures/jira/*.json` through a fake
  `fetch`/`request`. Re-captured fixtures must follow the scrub rules in
  `test/fixtures/jira/README.md`.
- **I16: the API key is never persisted in settings or the DB and never returned to the
  renderer.** It lives only `safeStorage`-encrypted under `<dataDir>/credentials/` (0600).
  Error messages and logs must not echo it.
- **TLS:** the gateway's cert chains to the internal israel.final CA. Node's bundled roots
  don't include it, so the transport (`https-fetch.ts`) adds the system bundle. Don't swap
  it for global `fetch`.
- **Fetch is a query; import is one command.** The import use case re-classifies the issues
  itself (it never trusts the renderer) and creates all New issues in one transaction.
