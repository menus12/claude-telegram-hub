import type { OutboundMessage } from "./messages.js";

/**
 * Attribution prefix for an agent's message. One bot posts everything in a
 * shared room, so each outbound is prefixed with the speaking agent's name to
 * keep the transcript legible (e.g. `re-infra ▸ …`).
 */
export function attributionPrefix(agent: string): string {
  return `${agent} ▸ `;
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
