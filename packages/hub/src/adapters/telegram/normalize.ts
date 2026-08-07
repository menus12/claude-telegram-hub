import type { InboundMessage } from "@claude-telegram-hub/protocol";
import { parseMentions } from "./mentions.js";
import type { TgMessage } from "./types.js";

/** The replied-to message, as much as routing needs to identify its author. */
export interface ReplyContext {
  room: string;
  messageId: number;
  /** Visible text of the replied-to message (carries the `agent ▸ …` prefix). */
  text?: string;
}

/**
 * Resolves an inbound reply's target message to the agent that authored it, so a
 * Telegram *reply* can address an agent without an `@tag`. Returns `undefined`
 * when the replied-to message wasn't an agent's.
 */
export type ReplyTargetResolver = (reply: ReplyContext) => string | undefined;

/**
 * Normalize a Telegram message into the transport-agnostic `InboundMessage`,
 * or `null` if it isn't routable. Works uniformly for DMs (`chat.type` private)
 * and groups: `room` is the chat id, so a reply goes back where it came from.
 * Messages from bots, and those with neither text/caption nor an attachment, are
 * dropped (the hub never processes other bots; agent↔agent traffic is re-injected
 * internally). A photo/document is routed by its caption; `attachments` names it
 * (the bytes travel separately, fetched by the adapter).
 *
 * A Telegram reply to an agent's message is treated as addressing that agent:
 * `resolveReplyTarget` maps the replied-to message back to its agent, which is
 * added to `mentions` so hub routing is unchanged. Reply-to and `@tags` compose.
 */
export function toInboundMessage(
  msg: TgMessage,
  sigil: string,
  resolveReplyTarget?: ReplyTargetResolver,
): InboundMessage | null {
  if (!msg.from || msg.from.is_bot) return null;
  const text = msg.text ?? msg.caption ?? "";
  if (text === "" && !msg.attachment) return null;
  const room = String(msg.chat.id);
  const mentions = parseMentions(text, sigil);
  const repliedTo = msg.reply_to_message;
  if (repliedTo && resolveReplyTarget) {
    const agent = resolveReplyTarget({
      room,
      messageId: repliedTo.message_id,
      ...(repliedTo.text !== undefined ? { text: repliedTo.text } : {}),
    });
    if (agent && !mentions.includes(agent)) mentions.push(agent);
  }
  return {
    adapter: "telegram",
    room,
    fromKind: "human",
    fromId: String(msg.from.id),
    text,
    mentions,
    ...(msg.attachment ? { attachments: [msg.attachment.filename] } : {}),
  };
}
