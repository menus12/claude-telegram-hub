# Runbook: adopt the central coordination protocol

**What.** A reusable prompt that makes a project repo **reference** the canonical shared-room
coordination protocol — [`docs/coordination.md`](../coordination.md) in this repo — instead of
carrying its own copy of the general rules, through the normal issue → branch → PR → merge flow,
then signals peer agents to do the same so everyone converges on the latest version.

**Why.** Conventions drift when each repo keeps its own copy. If every project *links* the canonical
protocol (on `main`) and its sessions **re-read** it, a change here propagates by reference — no
content to copy, nothing to go stale. Each repo keeps only what's genuinely its own (agent name,
domain, peers).

**When.** Onboarding a new project onto the hub, or after the central protocol changes and you want
every project pointing at the latest.

---

## The prompt

Paste this to the project's agent — in its repo terminal, or `@tag` it in the shared room. It is
idempotent: safe to run whether the repo has a stale copy, a section buried in other docs, or
nothing yet.

```text
Centralize this repo's shared-room coordination conventions on the canonical protocol — reference
it, don't keep a local copy.

Canonical protocol (always latest, on main):
https://github.com/menus12/claude-telegram-hub/blob/main/docs/coordination.md

Do it issue-first, changing only THIS repo's files:

1. Read the canonical protocol above — it is the source of truth for how agents behave in the
   shared room.
2. Find anywhere in this repo that restates *general* multi-agent / shared-room coordination rules:
   a local agent-coordination.md, a coordination section in CONTRIBUTING.md or docs/conventions.md,
   or wherever this project documents agent behavior in its committed engineering docs. Replace the
   general content with a short pointer to the canonical protocol. Keep ONLY what is genuinely
   repo-specific — this agent's name and domain, which peers it coordinates with, repo-specific
   ownership/escalation notes. Do not duplicate the rules; link them.
3. Ensure whatever your repo uses to brief its agents (its committed engineering docs) *references*
   the canonical protocol, so every session picks up the latest by reading the link, not by carrying
   a copy.
4. Open an issue ("Reference the central coordination protocol"), branch, and open a PR that links
   it (Closes #N). Merge after review.
5. Re-read the canonical protocol now, so you are on the current rules immediately.

Then propagate — one concrete ask, no ping storm:

6. In the shared room, tag the peer agents ONCE:
   "@peerA @peerB — coordination conventions are centralized at
   https://github.com/menus12/claude-telegram-hub/blob/main/docs/coordination.md . Reference it from
   your repo (drop any local copy) and re-read the latest."
   This is a concrete act-request, so tagging is correct (protocol Part A rule 2). Keep it to that
   one line; put nothing else in the room.
7. If you were the one *pinged* (not the operator's initial seed): do steps 1–5 and re-read, but do
   NOT re-broadcast. The operator seeds one agent per project; pinged peers adopt without re-fanning,
   so the reference chain converges instead of looping.
```

---

## Notes

- **Convergence, not a loop.** The operator seeds the prompt to **one** agent per project. That
  agent pings its peers once (step 6); each pinged peer adopts and re-reads but does not re-broadcast
  (step 7). So the chain fans out once and stops — consistent with the protocol's noise rules and the
  loop governor (a stray re-broadcast storm would just get frozen anyway).
- **Latest by construction.** The link points at `main`, and sessions re-read it, so "pick up the
  latest" needs no version bumps — publish a change here and the next re-read has it.
- **Single-writer holds.** Each repo edits only its own files; this repo's `docs/coordination.md`
  stays the one place the general rules live.
