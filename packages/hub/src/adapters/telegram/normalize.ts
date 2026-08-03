import type { InboundMessage } from "@claude-telegram-hub/protocol";
import { parseMentions } from "./mentions.js";
import type { TgMessage } from "./types.js";

/**
 * Normalize a Telegram message into the transport-agnostic `InboundMessage`,
 * or `null` if it isn't routable. Works uniformly for DMs (`chat.type` private)
 * and groups: `room` is the chat id, so a reply goes back where it came from.
 * Messages from bots and messages without text are dropped (the hub never
 * processes other bots; agent↔agent traffic is re-injected internally).
 */
export function toInboundMessage(msg: TgMessage, sigil: string): InboundMessage | null {
  if (!msg.text || !msg.from || msg.from.is_bot) return null;
  return {
    adapter: "telegram",
    room: String(msg.chat.id),
    fromKind: "human",
    fromId: String(msg.from.id),
    text: msg.text,
    mentions: parseMentions(msg.text, sigil),
  };
}
