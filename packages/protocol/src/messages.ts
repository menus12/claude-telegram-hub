import { z } from "zod";

/**
 * Who a message came from. `human` is a real platform user; `agent` is another
 * Claude session whose reply the hub re-injects (the platform never delivers
 * bot→bot, so agent→agent hops travel through the hub).
 */
export const fromKindSchema = z.enum(["human", "agent"]);
export type FromKind = z.infer<typeof fromKindSchema>;

/**
 * Reserved mention tokens that address **all live agents** in the room rather than
 * a single named agent — the broadcast primitive (`@all …`, or "everyone …" by
 * voice). Recipients are just a set, so unicast/multicast/broadcast differ only in
 * cardinality; broadcast is the case where the hub expands the token to the whole
 * live roster. Case-insensitive; reserved (an agent can't take one of these names)
 * when broadcast is enabled.
 */
export const BROADCAST_ALIASES: ReadonlySet<string> = new Set(["all", "everyone", "team"]);

export function isBroadcastMention(name: string): boolean {
  return BROADCAST_ALIASES.has(name.toLowerCase());
}

/**
 * Canonical tokens an agent uses to address the **human operator** (not an agent).
 * A reply mentioning one of these makes the hub render a real Telegram mention of
 * the operator (a visible badge + a reply to their last message, which breaks
 * mute) — so an agent that genuinely needs a decision can reach the human even in
 * a muted chat. It is never routed to an agent. (#94)
 */
export const OPERATOR_ALIASES: ReadonlySet<string> = new Set(["operator", "op"]);

export function isOperatorMention(name: string): boolean {
  return OPERATOR_ALIASES.has(name.toLowerCase());
}

/**
 * A message arriving at the hub from a transport adapter (or re-injected from
 * another agent), normalized into a transport-agnostic shape. This is what the
 * router reasons about; nothing here is Telegram-specific.
 */
export const inboundMessageSchema = z.object({
  /** Adapter that produced this message, e.g. "telegram". */
  adapter: z.string().min(1),
  /** Platform-native chat/group id the message belongs to. */
  room: z.string().min(1),
  fromKind: fromKindSchema,
  /** Platform user id for humans, or the agent name for re-injected messages. */
  fromId: z.string().min(1),
  text: z.string(),
  /** Resolved agent names tagged in the message (routing is mention-only). */
  mentions: z.array(z.string().min(1)).default([]),
  /** Optional attachment references (urls / file ids); resolved by the adapter. */
  attachments: z.array(z.string()).optional(),
  /**
   * True when `text` is the transcript of a voice note. The hub applies voice-only
   * behavior to these: spoken-name/broadcast addressing (speech has no `@tags`) and
   * a transcript echo so the operator can catch a mis-hear.
   */
  voice: z.boolean().optional(),
  /**
   * Quoted context from a reply-to: when the operator replies to an earlier message
   * while tagging an agent, the tagged agent gets that message as context (so a
   * just-in-time peer catches up without the operator re-stating it). `author` is
   * the quoted message's agent when known; `text` is its body (attribution prefix
   * stripped). Selective by design — only the tagged recipients receive it.
   */
  replyTo: z
    .object({ author: z.string().min(1).optional(), text: z.string().min(1) })
    .optional(),
});
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

/**
 * Where an outbound message should be delivered. Adapter + room is the minimum;
 * `replyToId` optionally anchors the message to a specific platform message.
 */
export const routeTargetSchema = z.object({
  adapter: z.string().min(1),
  room: z.string().min(1),
  replyToId: z.string().optional(),
});
export type RouteTarget = z.infer<typeof routeTargetSchema>;

/**
 * A message leaving the hub through an adapter. `agent` names the speaker so the
 * adapter can attribute it (one bot posts everything). `kind` distinguishes an
 * agent's reply from a hub-generated notice (offline target, governor freeze).
 */
export const outboundMessageSchema = z.object({
  /** Speaking agent, used for the attribution prefix. "hub" for system notices. */
  agent: z.string().min(1),
  text: z.string(),
  kind: z.enum(["reply", "notice"]).default("reply"),
  /**
   * Platform user ids to render as a real mention of the human operator (#94).
   * The adapter turns each into a mention entity (a visible `@` badge) and replies
   * to that user's last message so it breaks through a muted chat. Empty/omitted =
   * a normal post.
   */
  mentionUserIds: z.array(z.string().min(1)).optional(),
});
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

/**
 * A file carried over the session↔hub link as bytes. The channel is always
 * co-located with its session, so it is what materializes an inbound file to a
 * local path (and reads a local path for an outbound one) — the hub only moves
 * bytes. This keeps file transfer working whether the hub is co-located or remote.
 * `dataBase64` is the raw file base64-encoded; size is bounded per deployment.
 */
export const filePayloadSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
});
export type FilePayload = z.infer<typeof filePayloadSchema>;

/**
 * A file leaving the hub through an adapter: the speaking agent (for caption
 * attribution), the bytes, and an optional caption. The adapter chooses how to
 * present it (e.g. Telegram photo vs document) from the file's mime/size.
 */
export const outboundFileSchema = z.object({
  agent: z.string().min(1),
  file: filePayloadSchema,
  caption: z.string().optional(),
});
export type OutboundFile = z.infer<typeof outboundFileSchema>;
