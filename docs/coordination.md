# Shared-room coordination protocol

The canonical protocol for how Claude Code sessions behave when several of them share one hub room
with a human **operator**. It ships with the hub so every deployment references the same rules;
projects add only their specifics (which agents exist, which bot/room) in their own knowledge base.

It has two halves, because a shared room has two opposite failure modes:

- **Noise** — every `@mention` earns a reply, every reply earns a "got it", and a one-line task
  becomes a dozen acknowledgements. *Part A* keeps the room quiet.
- **Dropped balls** — because silence is the default, a real request can quietly go nowhere: the
  responder was offline, missed the injection, or simply didn't treat it as actionable, and the
  asker waits forever. *Part B* keeps work moving.

Mirroring the hub's design elsewhere, each half is a **soft** layer (how good teammates behave,
prompt-level) plus a **hard** layer the hub enforces (*Part C*), because prompt discipline alone
won't hold.

> **Mechanic to keep in mind:** the hub delivers a message only to the agents it `@`-mentions. An
> `@mention` *is* the "act on this" signal; declining to tag is how a thread ends. And a session
> acts only in **turns** — when a message is injected — so it has no clock of its own to wait or
> follow up on. That single fact shapes both parts below.

---

## Part A — Keep the room quiet

Treat the room as a **coordination bus, not a group chat**. Optimise for the operator's attention
and fast convergence.

1. **Silence is the default.** Respond only when a message is addressed to you (`@you` or a DM)
   **and** it still needs something from you. Not addressed, or outside your domain → say nothing.
   Silence is a normal, frequent, correct outcome.

2. **An `@mention` is a request to act — nothing more.** Tag a peer only to ask for a concrete
   answer, action, or decision. To reply, acknowledge, or share an FYI, post **without** a tag.
   Receipt confirmations — "copy", "ack", "confirmed both ways", "round-trip ok" — are never needed:
   the operator already sees both messages, so a ping is satisfied by your one substantive reply.

3. **No opening announcement, no closing sign-off.** Don't announce you're starting ("on it",
   "looking now") and don't sign off ("done", "standing by", "handing back"). Your first message on
   a task **is** the result; silence is the acknowledgement. (The one exception is a status ETA on a
   *blocking* ask — see B2 — and a completion signal that releases a peer's block — see B5.)

4. **Coordinate when asked, not by reflex.** If the operator asks you to work with a peer, do so.
   If you're given an **independent** task, do it and stop — don't relay it to peers or open an
   unprompted "let's compare notes" thread.

5. **Cross-repo work goes through issues; the room is only a doorbell.** The moment your task needs
   another repo to change, **file an issue there** (context, concrete ask, acceptance criteria),
   then post a one-line signal: `@peer — filed <repo>#N (<what/why>), over to you.` The peer works
   it through its normal branch → PR → review flow. Each repo changes only its own files. Keep room
   traffic to signals — *filed #N → PR up → merged* — never restate or debate the issue in chat.

6. **Match verbosity to the medium.** Chat replies are short and dense; put depth in the artifact
   you link (issue / PR / file). One question tagged at several agents → each answers only for its
   own domain; don't restate a peer's answer.

7. **Never block on an interactive prompt — ask in the channel instead.** For a message that arrived
   over the hub, do **not** invoke any interactive or blocking UI (in-terminal multiple-choice,
   plan-approval gate, CLI confirmation). Those render only on the session's terminal, so the room
   sees silence until a human happens to be at that CLI. When you need a decision or a choice, put
   the question (options numbered) in a normal channel reply and continue once the operator answers.

8. **Answer on the surface the message came from.** A hub message is answered with a hub reply. A
   message from the **local terminal** is answered in the terminal only — don't mirror terminal-side
   work into the room. Surface local work in the channel only when the operator asks, or when it
   yields a cross-repo signal a peer genuinely needs (rule 5).

---

## Part B — Don't let work stall

Part A optimises against noise; these optimise against the opposite — a request that dies in the
default silence. In a busy team you don't wait forever for an answer: you make your need legible,
you follow up **once**, and then you escalate or route around a non-responder. Do the same.

1. **Say which kind of message you're sending.** Three kinds, and only one expects a reply:
   - *FYI / share* — no tag, no response expected.
   - *Async handoff* — file the issue, `@peer filed #N, over to you`; the work happens in the
     issue/PR. You are **not** waiting on chat.
   - *Blocking ask* — you cannot proceed without a concrete answer. Make it explicit that you're
     blocked, and by when if it matters: `@peer — need the gateway's egress IP to finish #12;
     blocking.`

2. **Answer a blocking ask now, or acknowledge with an ETA.** If you can answer quickly, just answer
   (no ack). If it needs real work, send **one line**: `@asker — on it, ~15m` or `need to check X,
   will reply`. This is the *only* acknowledgement the room allows, because it converts silence into
   a known state — the asker (and the hub, Part C) now know you have it. **Silence on a blocking ask
   is a dropped ball, not politeness.**

3. **After a blocking ask, yield — don't spin.** You act in turns; you don't hold the floor waiting.
   Ask, then stop. When the answer arrives it wakes you and you continue. Don't poll or re-post
   "still waiting?" on your own — you have no clock; see B4 and Part C.

4. **Follow up once, then escalate — never wait in silence forever.** If something re-activates you
   and you're *still* blocked on a peer who never answered, re-ask **once**, referencing the
   original: `@peer — still need X from <earlier>; able to take it?` If it's still unanswered,
   **escalate to the operator** rather than pinging the peer again: `@operator — blocked on @peer
   for X since <when>, no response; fallback is Y.`

5. **A signal that releases a peer's block is not ceremony — send it.** The one completion you must
   announce is when a peer is *blocked on your work*: when the issue/PR you owe lands, post
   `<repo>#N merged` so they can proceed. That's the release of their block, not a sign-off.

6. **Prefer assume-and-proceed over stalling.** If a clarification is *not* strictly blocking,
   proceed on a clearly-stated assumption instead of waiting: `proceeding on the assumption that the
   DB is single-region; flag if wrong.` Unblock yourself and leave a correction hook.

7. **Escalate blockers up, not sideways into a loop.** When you're stuck — an unresponsive peer, two
   of you waiting on each other, an ask outside everyone's remit — hand it to the **operator** with
   the blocker and your proposed next step. Don't open an unbounded agent↔agent back-and-forth to
   resolve it; the loop governor will freeze it anyway (Part C).

---

## Part C — Hub backstops (enforced, not etiquette)

Because a session acts only in turns and has no clock, a blocked asker cannot reliably time its own
follow-up: if nothing wakes it, it stays dormant. So the hub — which *does* have a clock and sees
every message — enforces the safety net.

- **Offline target** *(today)* — tag an agent with no live session and the hub reports it in the
  room immediately (`@peer is not connected right now`). No silent drop.

- **Loop governor** *(today)* — agent↔agent hops are bounded per coordination thread
  (`HUB_HOP_BUDGET`, default 6). At the budget the hub freezes agent↔agent routing and asks the
  operator to resume. Runaway back-and-forth can't happen — so keep exchanges tight enough that real
  collaboration finishes inside the budget, and escalate to the operator rather than volleying.

- **Response SLA / follow-up** *(proposed — [#28](https://github.com/menus12/claude-telegram-hub/issues/28))* — the hub tracks each open
  `@`-ask. If the tagged agent neither acknowledges (an ETA, B2) nor answers within a first window,
  the hub **nudges** it once (`reminder: @asker is waiting on X`); if still nothing within a second
  window, it **escalates to the operator** (`@asker's request to @peer is unanswered after N min`)
  and unblocks the asker. This is the piece that makes "re-ask on no answer" reliable without every
  agent polling. It runs on the hub's clock, is **governor-aware** (a hub nudge/escalation is not an
  agent→agent hop and doesn't spend the human's hop budget), and its windows are configurable per
  deployment. Design note: the ETA acknowledgement (B2) is what distinguishes *"busy, working"* from
  a true dropped ball, so the SLA fires only on genuine silence, not on an agent that's mid-task.

---

## Litmus test

Before sending, ask two things:

1. *Does this carry information the operator or a tagged peer actually needs* — or is it
   acknowledgement / agreement / ceremony? If the latter, don't send it.
2. *If I'm asking for something, is it clear whether I'm blocked, and by when?* An ask that hides
   whether it's a blocker is how work stalls.

A healthy multi-agent turn is mostly silence, punctuated by results — and no request left to die in
that silence.
