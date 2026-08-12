# Rule: keep Claude/session/task state logic in sync with CLAUDE_STATE_PRD.md

`CLAUDE_STATE_PRD.md` (repo root) is the product spec for session/task **status**: the states
(Idle / Working / Needs input / Unknown), the icons, the display priority
(`Needs input > Ready for review > Working > Idle > Unknown`), ready-for-review raise/clear timing, the
state-change notification (toast), and the edge cases. Treat it as authoritative for *behavior*
(the way `DESIGN.md §` sections are authoritative for architecture).

## When this rule applies — "state logic"

Any change whose behavior touches session state, task-state rollup, status icons,
ready-for-review, or state-change notifications. Judge by intent, not just path. The core files
today (non-exhaustive — new ones will appear):

- `src/domain/state.ts`, `src/domain/lifecycle.ts`, `src/domain/task-state-aggregator.ts`,
  `src/domain/session.ts`
- anything under `src/adapters/claude/` (esp. `octopus-claude-state.script.ts`,
  `claude-state-watcher.ts`, `claude-hooks.ts`)
- `src/renderer/src/store/display-state.ts`, `src/renderer/src/store/notification-throttle.ts`,
  `src/renderer/src/store/store.ts` (state-related reducers), `src/renderer/src/components/StatusIcon.tsx`
- the `ingestSessionState` use case and any DTO/event that carries state

## Before editing state logic

Read `CLAUDE_STATE_PRD.md` first (if you haven't already this session) so you change behavior in
line with the spec. Cross-check `DESIGN.md §9` for the mechanism.

## After editing state logic

1. **Run the co-located tests first** — fast and deterministic. Cover the touched areas, e.g.:
   `npx vitest run src/domain src/adapters/claude src/application/use-cases/ingest-session-state.test.ts src/renderer/src/store`
2. **For changes that alter state _behavior_** (skip for pure renames, comments, or formatting),
   run a **sub-agent** (Task tool, `general-purpose`) to verify against the PRD. Give it:

   > Read `CLAUDE_STATE_PRD.md` and the changed files `<list>`. Determine whether the change
   > conflicts with the PRD — states, icons, state priority, ready-for-review raise/clear timing,
   > state-change notification behavior, and everything in the PRD's **"Edge cases"** section
   > (treat the PRD text as authoritative; do not rely on a summary). For each conflict report:
   > **PRD requirement** vs. **what the code now does**, with `file:line`. If none, say so.

Surface any failing tests or reported conflicts to me before considering the task done. If the new
behavior is a deliberate change, update `CLAUDE_STATE_PRD.md` (and the tests) in the same change
rather than letting it drift.
