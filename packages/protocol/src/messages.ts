import { z } from "zod";

/**
 * Who a message came from. `human` is a real platform user; `agent` is another
 * Claude session whose reply the hub re-injects (the platform never delivers
 * bot→bot, so agent→agent hops travel through the hub).
 */
export const fromKindSchema = z.enum(["human", "agent"]);
export type FromKind = z.infer<typeof fromKindSchema>;

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
