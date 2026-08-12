import { ATTRIBUTION_SEPARATOR, type InboundMessage } from "@claude-telegram-hub/protocol";
import { parseMentions } from "./mentions.js";
import type { TgMessage } from "./types.js";

/** Longest quoted body we thread as context; a pathological quote is truncated. */
const MAX_QUOTE_CHARS = 1500;

/** Split a replied-to message into its attribution author (if any) and body text. */
function splitQuoted(text: string): { author?: string; body: string } {
  const idx = text.indexOf(ATTRIBUTION_SEPARATOR);
  if (idx > 0 && idx <= 40) {
    const name = text.slice(0, idx);
    if (/^[A-Za-z0-9_-]+$/.test(name)) {
      return { author: name, body: text.slice(idx + ATTRIBUTION_SEPARATOR.length) };
    }
  }
  return { body: text };
}

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
 * A Telegram reply carries selective context: with **no** `@tag` it addresses the
 * replied-to agent (continue the thread); **with** an `@tag` the tag wins as the
 * recipient and the replied-to message rides along as `replyTo` context, so the
 * operator can pull a just-in-time peer into a thread without re-stating it.
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
  let replyTo: { author?: string; text: string } | undefined;
  if (repliedTo && resolveReplyTarget) {
    const author = resolveReplyTarget({
      room,
      messageId: repliedTo.message_id,
      ...(repliedTo.text !== undefined ? { text: repliedTo.text } : {}),
    });
    if (mentions.length > 0) {
      // Explicit @mentions win as the recipients; the reply-to is CONTEXT — thread
      // the quoted message to whoever was tagged so a just-in-time peer catches up
      // without the operator re-stating it. (The reply-to author is NOT re-pinged.)
      if (repliedTo.text) {
        const { author: fromPrefix, body } = splitQuoted(repliedTo.text);
        const trimmed = body.length > MAX_QUOTE_CHARS ? `${body.slice(0, MAX_QUOTE_CHARS)}…` : body;
        const quotedAuthor = author ?? fromPrefix;
        if (trimmed.trim()) replyTo = { ...(quotedAuthor ? { author: quotedAuthor } : {}), text: trimmed };
      }
    } else if (author) {
      // No explicit tag: the reply-to addresses that agent (continue the thread).
      // No quote — it's the agent's own prior message, so it already has the context.
      mentions.push(author);
    }
  }
  return {
    adapter: "telegram",
    room,
    fromKind: "human",
    fromId: String(msg.from.id),
    text,
    mentions,
    ...(msg.attachment ? { attachments: [msg.attachment.filename] } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}
