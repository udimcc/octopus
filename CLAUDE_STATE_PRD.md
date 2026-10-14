# Claude State - Product Requirements Document

## Introduction

Octopus runs many Claude Code sessions in parallel. The product's core scan is _"ten agents
running — which one just finished and wants my eyes, and which one is blocked on me?"_ To answer
that at a glance, every session (and, rolled up, every task) shows a **status icon** reflecting what
its Claude session is doing right now.

This document is the product-level requirements for that status feature: the states, the icons, how
they roll up and prioritize, the "ready for review" cue, and the notifications. It is intentionally
UI/behavior focused; the detection mechanism (how state is observed) lives in `DESIGN.md §9`.

**Scope.** Status is reported **only for Claude Code sessions**. A plain shell, an editor, or any
other foreground program has **no** status and shows **no** icon (state `Unknown`). We never guess a
status from process activity or terminal output.

## States

A Claude session is always in exactly one of four states:

| State | Meaning | Example |
|---|---|---|
| **Idle** | Claude is at rest — a turn finished, or the session is freshly sitting at a prompt. No work in flight, nothing needed from the user. | Claude answered and is waiting for the next prompt. |
| **Working** | Claude is actively doing something. | Claude is thinking, editing files, or running a tool. |
| **Needs input** | Claude has stopped and needs the user before it can continue. | A permission/approval request, or Claude asking the user a question (`AskUserQuestion`). Also used for a session whose terminal has exited or failed to start. |
| **Unknown** | No status signal (not a Claude session, Claude hasn't reported yet, or Claude has exited). | A shell, an editor, a session that just launched, or a terminal whose Claude was quit. |

Notes:
- **Idle** means _no Claude work at all AND no input needed_. A finished turn is Idle; a turn
  awaiting permission is Needs input, not Idle.
- **Needs input** distinguishes two real situations that look similar — a genuine permission request
  vs. an idle "waiting for your input" reminder. Only a genuine request counts as Needs input; an
  idle reminder leaves the session Idle.

## Ready for review

**Ready for review** is a UI highlight layered on top of the states — not a fifth state. It answers
"which agent _just_ finished, and I haven't looked yet?"

The cue is a **raise-unconditionally / suppress-at-display-time** split. Raising records a durable
fact — "a turn finished since this session was last on screen" — without consulting focus at that
instant; whether the highlight actually *shows* is re-decided continuously as the UI renders. This
is deliberate: on the GPU-less VDI host the on-screen/focus signal is briefly unreliable at the exact
moment a turn ends, so a focus check taken *at the transition instant* is fragile (it caused a stuck
review dot for a session the user watched finish). Evaluating "is it on screen?" at display time uses
the reliable steady-state truth instead.

**When it is raised:**
- A session transitions **Working → Idle** (Claude finished a turn). This is **unconditional** — the
  marker is set regardless of whether the session is on screen at that moment.

**When it is NOT raised:**
- A session that goes straight to Idle **without** a prior Working turn (e.g. freshly spawned at a
  prompt) — nothing was "finished".
- A **Needs input → Idle** transition (the user was already being asked; resolving it isn't new
  finished work).

**When it is shown (the highlight surfaces):** only while the session is **currently Idle** AND
**not currently on screen** (not the active tab of a focused window) — both gates re-checked every
render. A session the user is looking at shows **no** cue while they look (display-time suppression),
and being on screen also **marks it seen**: as long as it is the visible tab of a focused window the
unseen-marker is cleared continuously, so a turn that finishes **in place while the user is watching**
is recorded as seen and does **not** resurface the cue when the user later switches away. The cue
surfaces only for a finished turn the user has **not** had on screen since it finished — honoring "if
I can see Claude finish myself I don't need a cue" at display time (via settled present-time focus),
not by withholding the raise.

**When the marker clears:**
- **Primary:** the user has the session **on screen** — either by *bringing* it there (its tab
  becomes active in a focused window) or by *watching it there* when the turn finishes in place. Being
  on screen clears the "unseen" memory continuously — re-checked every render against the reliable
  present-time focus, never the flaky finish instant — so the cue won't appear when they switch away.
  Both clears are **global** across windows so the task rollup stays consistent regardless of which
  window hosts the session: the bring-on-screen (focus-transition) clear broadcasts inherently, and the
  watch-in-place clear — which fires no focus transition — is **relayed** by the hosting window to the
  others (it reports the session "seen" so every window drops the marker).
- **Defense-in-depth:** the session **leaves Idle** again (starts Working, or goes to Needs input) —
  the "just finished, unseen" premise no longer holds.

**Split panes.** When a task is split into several visible panes, **only the focused pane** counts as
"on screen". A pane that is visible but not focused still raises and shows the cue, and the cue clears
when the user focuses that pane (a click in it, or a pane-focus shortcut), globally like any other
focus. This keeps "on screen" a single, unambiguous session per window, and a finish in a side pane
you aren't working in is still flagged for you.

**Validity / supersession:** because the highlight is gated to the Idle branch at display time, if the
agent starts working again before the user looks, the current state (Working / Needs input) is shown
instead — a running session never displays the static review dot.

## Icons

Icons are minimal inline glyphs (no icon library) so they render identically everywhere. The icon
reflects the **display state** (states + ready-for-review folded together):

| Display state | Glyph | Color | Motion | Label |
|---|---|---|---|---|
| **Needs input** | ▲ | red | static | "Needs input" |
| **Ready for review** | ● | teal (accent) | static | "Ready for review" |
| **Working** | ● | blue | gentle pulse | "Working" |
| **Idle** | ○ | muted | static | "Idle" |
| **Unknown / none** | _(none)_ | — | — | renders nothing |

- **Working vs. Ready for review** are the _same_ dot — the pulse is the only thing that
  distinguishes "still running" (pulsing) from "done, wants your eyes" (static).
- **Unknown** renders **nothing** so a not-yet-evaluated session never masks a more urgent one.
- Each icon exposes its label as a tooltip / accessible name.

## State priority

When one icon must represent multiple signals — or a task must summarize its sessions — a single
priority ordering decides which wins. Highest → lowest:

```
Needs input  >  Ready for review  >  Working  >  Idle  >  Unknown (none)
```

Rationale:
- **Needs input wins everything** — a blocked session demands action before anything else.
- **Ready for review beats Working** at the task level so a finished-and-unseen session isn't hidden
  by a busy sibling — _but_ review is gated to only-while-idle (above), so a session that is _itself_
  working shows Working, never review.
- **Unknown is lowest** and shows no icon.

## Task icons

A **task** shows a single rolled-up icon summarizing all its sessions:
- The task icon is the **maximum** display state over the task's sessions, using the priority above.
  One blocked session makes the whole task show Needs input; otherwise a ready-for-review session
  makes it show review; otherwise a working session makes it show Working; etc.
- If every session is Unknown, the task shows no icon.
- The rollup spans sessions in **any** window — a task's summary is consistent regardless of which
  window happens to host its sessions.

## State-change notifications

Alongside the passive icon, a state change raises an **active** cue so the user notices a session
changed even while looking elsewhere.

- **In-app toast.** A top-right toast with a bold **"State changed"** title over a `<Task> - <Session>`
  body. It is deliberately **stateless** — it does _not_ say old→new state; the user glances and
  checks the session themselves. (This avoids showing a stale or double-fired delta when a turn both
  ends and then asks for permission.)
- **Fires on meaningful transitions only** — any real change, except transitions into or out of
  Unknown, and no-ops.
- **Suppressed when already looking.** No toast if the user is currently viewing that exact session
  (focused window, active task, active tab). If I can see Claude myself, I don't need a toast.
  With split panes, "active tab" means the **focused pane** only; a visible but unfocused pane still
  gets the toast (same rule as the ready-for-review cue).
- **Throttled per session.** A burst of changes for one session collapses to **one** toast: the first
  change shows immediately, further changes are dropped for a short cooldown (~6 s). The cooldown is
  anchored to the toast actually shown, so a suppressed change never "uses up" the window.
- **Can be turned off** via a setting (`terminal.statusChangeNotifications`, default on).
- **Icons are independent of the toast.** Tab and task icons always update instantly on every state
  change, regardless of whether a toast is shown or throttled.

## Edge cases

- **Background agents (sub-agents).** If a Claude session delegates to background agents (the
  `Task`/`Agent` tool), the **whole session stays Working** until every sub-agent finishes — even
  though the main agent may momentarily appear to stop. The session must **not** flash Idle or
  ready-for-review while a sub-agent is still running, and must not flicker done-then-working when a
  sub-agent returns and the main agent resumes.
  - **One of several finishing.** When one of several background sub-agents finishes, the session
    stays Working while any other is still running.
  - **Fire-and-forget sub-agents.** When the main agent finishes but a background sub-agent is still
    running, the session stays Working; it goes Idle only once the last sub-agent has completed
    **and** the main agent has picked up its result (Claude wakes the main agent with the result;
    the session stays Working across that hand-off). If the result is never picked up, the session
    goes Idle after a short grace (~10 s of the main agent being at rest), and later turns are not
    held up by it.
  - **Only sub-agents count.** Background shells and scheduled jobs do not keep a session Working.
- **Needs input wins over background work.** A permission request or question — from the main agent
  or from a sub-agent — shows Needs input even while other sub-agents are still running.
- **Denied permission / Esc.** Denying a permission request, or interrupting Claude (Esc), ends the
  turn: the session goes **Idle** (with no sub-agent still running).
- **Claude exits.** Quitting Claude inside a terminal clears the icon (Unknown); the terminal is just
  a shell again.
- **Finished session must not revive.** Once a session is correctly Idle for a finished turn, a
  stray late signal must **not** flip it back to Working without a new user prompt.
- **`/clear`.** Clearing the conversation leaves the session **Idle**, not Working (a fresh/empty
  conversation is at rest).
- **Session resumed / app restarted.** When the terminal survives an Octopus restart (the durable
  daemon backend re-attaches it), the correct current status is recovered at once — a mid-turn
  session reads Working, a finished one reads Idle, running sub-agents are still counted. A terminal
  that is started **fresh** (no surviving process) shows **no** status until a Claude in it
  reports: whatever an earlier Claude was doing is gone with it.
- **Exited / failed session.** A session whose terminal exited or failed to start is treated as
  **Needs input** (it demands the user's attention).
- **Permission requests keep the session busy.** A session awaiting permission is Needs input and is
  still mid-turn — resolving the permission continues the same turn.
- **Ready-for-review is not persisted.** It is live UI memory only; an app restart starts with no
  review highlights.

## Known limitations

Accepted, low-frequency edge cases (detail in `DESIGN.md §9.7`):
- A sub-agent that crashes or is interrupted mid-run (no completion signal) can leave the session
  stuck Working until the main agent's next turn ends — a deliberate trade to never show "done"
  prematurely.
- If Claude's status signals aren't installed when a session starts mid-turn, that session may read
  Unknown until the next turn.
- A denied permission or an Esc fires no Claude hook; it is read from Claude's transcript, so it
  depends on Claude's transcript format (verified on Claude Code 2.1.x).
- A user-defined Claude `Stop` hook that makes Claude continue can show a brief Idle between the
  two halves of the turn.
- Approving a permission request fires no Claude signal, so the session stays **Needs input** until
  the approved tool finishes (a long command run after approval shows Needs input throughout).
  Denying the main agent's request is detected at once (above); a sub-agent's denied request clears
  when that sub-agent next acts or finishes.
