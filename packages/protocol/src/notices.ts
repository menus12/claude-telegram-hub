import type { OutboundMessage } from "./messages.js";

/** Separator between the speaking agent's name and its message text. */
export const ATTRIBUTION_SEPARATOR = " ▸ ";

/**
 * Attribution prefix for an agent's message. One bot posts everything in a
 * shared room, so each outbound is prefixed with the speaking agent's name to
 * keep the transcript legible (e.g. `re-infra ▸ …`).
 */
export function attributionPrefix(agent: string): string {
  return `${agent}${ATTRIBUTION_SEPARATOR}`;
}

/**
 * Inverse of {@link attributionPrefix}: recover the speaking agent's name from an
 * attributed message's **visible text** (e.g. a Telegram `reply_to_message.text`).
 * Returns `undefined` when the text isn't agent-attributed — notably hub notices,
 * which are posted verbatim without a prefix. This lets a reply-to-a-message be
 * routed to its author *without* any per-process index, so it survives a restart.
 */
export function parseAttribution(text: string): string | undefined {
  const idx = text.indexOf(ATTRIBUTION_SEPARATOR);
  if (idx <= 0) return undefined;
  const name = text.slice(0, idx);
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : undefined;
}

/**
 * Render an outbound message to the text an adapter should post. Replies are
 * attributed to the speaking agent; hub notices are posted verbatim.
 */
export function renderOutbound(msg: OutboundMessage): string {
  if (msg.kind === "notice") return msg.text;
  return `${attributionPrefix(msg.agent)}${msg.text}`;
}

/**
 * The in-room notice posted when a tagged agent has no live session. Tagged but
 * offline agents are reported, never silently dropped.
 */
export function offlineTargetNotice(agent: string): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text: `@${agent} is not connected right now — the message was not delivered.`,
  };
}

/**
 * The in-room notice posted when an agent's session first comes online, so the
 * operator can see who is currently reachable. Debounced hub-side (announced only
 * on the first live registration, not on restart churn).
 */
export function presenceOnlineNotice(agent: string): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text: `@${agent} is online.`,
  };
}

/**
 * The in-room notice posted when an agent's session goes offline, after a grace
 * window with no live session (so a reconnect within the window doesn't flap).
 */
export function presenceOfflineNotice(agent: string): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text: `@${agent} is offline.`,
  };
}

/**
 * The in-room notice the response-SLA posts to the operator when an agent→agent
 * `@`-ask goes unanswered past the answer window — the durable backstop for a
 * follow-up the asker's (possibly dead) session couldn't make itself.
 */
export function slaEscalationNotice(from: string, to: string, minutes: number): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text: `@${from}'s request to @${to} is unanswered after ${minutes} min (no ack or reply). Over to you.`,
  };
}

/**
 * The in-room notice posted when a second session tries to register under a name
 * an already-live session holds. The incumbent keeps the name; the newcomer is
 * rejected — this surfaces the collision so the operator can fix the duplicate.
 */
export function duplicateRegistrationNotice(agent: string): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text:
      `⚠️ a second session tried to register as @${agent} and was rejected — ` +
      `the existing session keeps the name.`,
  };
}

function quoteTranscript(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The transcript echo for a voice note: shows *who it was routed to* and *what was
 * heard*, so the operator can catch a mis-hear or mis-address before agents act.
 * A colleague-style paraphrase — one line, governor-neutral.
 */
export function transcriptEchoNotice(recipients: string[], transcript: string): OutboundMessage {
  const to = recipients.map((r) => `@${r}`).join(", ");
  return {
    agent: "hub",
    kind: "notice",
    text: `🎙️ heard → ${to}: "${quoteTranscript(transcript)}"`,
  };
}

/** A voice note arrived but nobody could be resolved as its recipient. */
export function voiceUnaddressedNotice(): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text:
      "🎙️ heard a voice note but couldn't tell who it's for — reply to an agent's " +
      "message, or start with their name (or “everyone”).",
  };
}

/** A voice note couldn't be transcribed (silence, noise, or a fetch failure). */
export function voiceUnclearNotice(): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text: "🎙️ couldn't make out that voice note — try again or type it.",
  };
}

/** A voice note arrived but transcription isn't configured for this deployment. */
export function voiceDisabledNotice(): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text: "🎙️ voice messages aren't enabled here — please type it.",
  };
}

/**
 * The in-room notice posted when a coordination thread's hop budget is exhausted
 * and the hub freezes agent→agent routing. A human message resumes the thread.
 */
export function loopFrozenNotice(): OutboundMessage {
  return {
    agent: "hub",
    kind: "notice",
    text:
      "Agent-to-agent coordination is paused (hop budget reached). " +
      "Reply in this room to resume it.",
  };
}
