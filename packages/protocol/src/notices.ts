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
