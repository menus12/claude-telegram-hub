# Shared-room coordination protocol

The canonical protocol for how Claude Code sessions behave when several of them share one hub room
with a human **operator**. It ships with the hub so every deployment references the same rules;
projects add only their specifics (which agents exist, which bot/room) in their own knowledge base.

> **Projects reference this file — they don't copy it.** To point a repo at this protocol (and
> propagate an update across projects), use the runbook:
> [adopt-coordination-protocol.md](runbooks/adopt-coordination-protocol.md).

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

## Rule 0 — Never block on local input (MUST)

**There is no human at your terminal.** You are driven entirely over the channel, so any prompt that
waits on a **local keypress** freezes you where no one can reach you: the operator's next messages
queue but are never delivered, peers `@`-asking you hit the response SLA for something you can't
answer, and — on a hardened host — **nothing** can unblock you remotely (TTY input injection is
disabled; the terminal is owned by whoever has physical access). One blocking prompt turns your
session into a black hole that swallows every queued message until someone walks over and presses a
key. That defeats the entire point of the hub.

Therefore:

- You **MUST NOT** raise an interactive, input-blocking prompt — no question modal, no plan-approval
  gate, no permission dialog that waits on a local keystroke. If a tool would prompt, don't call it
  in a way that blocks.
- **Every** question, clarification, choice, or approval request **MUST** go out as ordinary,
  non-blocking channel text (a `reply` to the room), so it reaches the operator over Telegram and
  your session stays live to the next message. A question is **asked, not awaited**: pose it, do the
  parts you can while you wait, and act when the answer arrives as a new message.
- This composes with Part B: **assume-and-proceed** on a non-blocking clarification (state the
  assumption and keep moving), and reserve a real question for a genuine fork.
- This is not a style preference — it is the one rule whose violation cannot be recovered remotely.

*(Prevention is also a deployment concern: attached sessions should run in a non-interactive
permission posture so tool-permission dialogs never block — see the deploy notes. Rule 0 is the
agent-behaviour half; the posture is the backstop.)*

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

7. **Never block on an interactive prompt — ask in the channel instead** (see **Rule 0**). Put the
   question, options numbered, in a normal channel reply and continue; never invoke UI that renders
   only on the session's terminal.

8. **Answer on the surface the message came from.** A hub message is answered with a hub reply. A
   message from the **local terminal** is answered in the terminal only — don't mirror terminal-side
   work into the room. Surface local work in the channel only when the operator asks, or when it
   yields a cross-repo signal a peer genuinely needs (rule 5).

9. **Answer in the operator's language.** Reply in the **same language the operator wrote in** —
   English gets English, Russian gets Russian. Match the human on anything they'll read (replies,
   voiced summaries, notices you author). Agent↔agent coordination can use whatever's clearest —
   usually English for code, identifiers, and commands — but the moment a human is the audience,
   mirror their language.

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

3. **After a blocking ask, yield — but arm a reminder.** You act in turns, so don't hold the floor
   waiting; ask, then stop. When the answer arrives it wakes you and you continue. To cover the case
   where it *doesn't* come, **arm a self-reminder**: background a timer (a `sleep` you run in the
   background, or a scheduled wake) that re-invokes your session after a sensible interval. Don't
   busy-poll — one armed timer, not a loop of "still waiting?". Cancel it once the answer arrives.

4. **When the reminder fires, follow up once — then escalate.** On wake (your timer fired, or
   anything else re-activated you), if you're *still* blocked on a peer who never answered, re-ask
   **once**, referencing the original: `@peer — still need X from <earlier>; able to take it?` If
   it's still unanswered after that, **escalate to the operator** rather than pinging the peer again:
   `@operator — blocked on @peer for X since <when>, no response; fallback is Y.` Then stop — one
   nudge, one escalation, no endless retries.

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

Agents follow up on their own asks (B3–B4): a backgrounded timer re-wakes a waiting session, so
most "no answer" cases are handled agent-side without any hub involvement. But that timer lives
*inside* the session — if the asker's session **restarts or dies**, its pending follow-up dies with
it, and the request is orphaned with no one watching. The hub is the one component that outlives any
session and sees every message, so it holds the **durable** net for exactly that gap.

- **Offline target** *(today)* — tag an agent with no live session and the hub reports it in the
  room immediately (`@peer is not connected right now`). No silent drop.

- **Loop governor** *(today)* — agent↔agent hops are bounded per coordination thread
  (`HUB_HOP_BUDGET`, default 6). At the budget the hub freezes agent↔agent routing and asks the
  operator to resume. Runaway back-and-forth can't happen — so keep exchanges tight enough that real
  collaboration finishes inside the budget, and escalate to the operator rather than volleying.

- **Response SLA / follow-up** *(today, opt-in — `HUB_SLA`)* — the durable backstop for a
  follow-up the asker *couldn't* make: its session crashed or restarted (its self-timer gone with
  it), or it never armed one. The hub tracks each open `@`-ask independently of any session: if the
  tagged agent neither acknowledges (an ETA, B2) nor answers within the first window (`HUB_ACK_SLA`),
  the hub **nudges** it once (`reminder: @asker is waiting on X`); if still nothing within the second
  window (`HUB_ANSWER_SLA`), it **escalates to the operator** (`@asker's request to @peer is
  unanswered after N min`) and unblocks the asker. It runs on the hub's clock, is **governor-aware**
  (a hub nudge/escalation is not an agent→agent hop and doesn't spend the human's hop budget), and
  its windows are configurable per deployment. Design note: the ETA acknowledgement (B2) is what
  distinguishes *"busy, working"* from a true dropped ball — any reply from the peer (ack or answer)
  satisfies the ask, so the SLA fires only on genuine silence, not on an agent that's mid-task.

---

## Voice (when the room speaks)

Some rooms carry voice both ways: the operator sends a voice note (transcribed and routed to you), and
you can render a short reply as a voice note (`reply(voice: true)`). Voice is a **modality choice**, not
a second channel — the same "match verbosity to the medium" rule (A6) governs it.

1. **Voice is opt-in, and only ever replies to an operator voice message.** Set `voice: true` on a
   reply **only** when the message you're answering came in as **voice** from the operator (its
   `<channel>` tag carries `voice="true"`) — and then do it **by default** for that reply (don't make
   them ask, and don't send text *and then* a separate voice note; one coherent reply). Everything
   else stays **text**: **never** voice an agent↔agent message, and **never** voice proactively or a
   reply to a text message. *(This assumes the hub's auto-voice is off — the intended posture. If a
   deployment turns `HUB_TTS_AUTO` on, it voices every speakable reply regardless of your intent,
   overriding this rule; keep it off so voice stays agent-controlled.)*
2. **Write for the ear, not the eye.** The spoken text is not your chat text read aloud. Expand or
   respell abbreviations and jargon a listener can't parse (`CAE` → "Container Apps", `ASAv` → "the
   Cisco ASA virtual appliance"). Keep **hex strings, IPs, code, paths, links, and exact values out of
   the spoken part** — say the gist, and put the precise values in the text/caption that rides along.
   When the natural spoken form differs from what you display, pass `voiceText` (the words to speak)
   alongside `text` (the exact detail, kept as the caption) rather than compromising one for the other.
3. **Gist + next action, within the cap.** A voiced reply is a short spoken summary (what happened,
   what's next), not the full detail. The hub voices only up to a length cap and skips code/links/long
   text, so keep it brief and speakable; the detail belongs in text.
4. **When *not* to voice.** Code, links, lists, exact values, or long technical detail → **text only**,
   even if the incoming was voice. Voicing those helps no one; the operator can ask you to say the gist.

(If the hub can't voice a reply — too long or unspeakable — it posts it as text. The `reply` tool
result tells you it fell back and why, e.g. *"over this hub's 300-char cap"*, so you can shorten to a
spoken summary and re-send; the hub logs it too. A "missing" voice note is diagnosable, not a mystery.)

---

## Litmus test

Before sending, ask two things:

1. *Does this carry information the operator or a tagged peer actually needs* — or is it
   acknowledgement / agreement / ceremony? If the latter, don't send it.
2. *If I'm asking for something, is it clear whether I'm blocked, and by when?* An ask that hides
   whether it's a blocker is how work stalls.

A healthy multi-agent turn is mostly silence, punctuated by results — and no request left to die in
that silence.
