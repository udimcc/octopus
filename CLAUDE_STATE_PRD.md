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
| **Needs input** | Claude has stopped and needs the user before it can continue. | A permission/approval request. Also used for a session whose terminal has exited or failed to start. |
| **Unknown** | No status signal (not a Claude session, or Claude hasn't reported yet). | A shell, an editor, or a session that just launched. |

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
  The bring-on-screen (focus-transition) clear is **global** across windows so the task rollup stays
  consistent; the watch-in-place clear is local to the hosting window (its cross-window corollary is a
  documented known limitation, below).
- **Defense-in-depth:** the session **leaves Idle** again (starts Working, or goes to Needs input) —
  the "just finished, unseen" premise no longer holds.

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
  - **Fire-and-forget sub-agents.** When the main agent finishes but a background sub-agent is still
    running, the session stays Working; it goes Idle only once the last sub-agent completes.
- **Finished session must not revive.** Once a session is correctly Idle for a finished turn, a
  stray late signal must **not** flip it back to Working without a new user prompt.
- **`/clear`.** Clearing the conversation leaves the session **Idle**, not Working (a fresh/empty
  conversation is at rest).
- **Session resumed / app restarted.** After Octopus (or the session) restarts, the correct current
  status is recovered — a mid-turn session reads Working, a finished one reads Idle.
- **Exited / failed session.** A session whose terminal exited or failed to start is treated as
  **Needs input** (it demands the user's attention).
- **Permission requests keep the session busy.** A session awaiting permission is Needs input and is
  still mid-turn — resolving the permission continues the same turn.
- **Ready-for-review is not persisted.** It is live UI memory only; an app restart starts with no
  review highlights.

## Known limitations

Accepted, low-frequency edge cases (detail in `DESIGN.md §9.7`):
- A sub-agent that crashes or is interrupted mid-run (no completion signal) can leave the session
  stuck Working until the next user prompt — a deliberate trade to never show "done" prematurely.
- If Claude's status signals aren't installed when a session starts mid-turn, that session may read
  Unknown until the next turn.
- A main agent that is blocked _while_ a background sub-agent is working may briefly show Working
  instead of Needs input (a single status can't hold both at once).
- If a session finishes a turn **in place** in a _secondary_ window where it was already the active
  tab, the **main window's task rollup** can still show Ready for review for it. The watch-in-place
  clear is **local** to the hosting window (the secondary window itself shows no cue), and a finish
  fires no on-screen *event* to broadcast, so the main window — which knows only its own focus — never
  learns the session was seen. It clears as soon as the user brings that session on screen from any
  window (a focus transition, which does broadcast). Low-frequency (needs the session hosted in a
  different window than the summary being read).
