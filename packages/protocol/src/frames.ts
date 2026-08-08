import { z } from "zod";
import { filePayloadSchema, inboundMessageSchema } from "./messages.js";

/**
 * The session↔hub wire protocol.
 *
 * Every session holds one persistent connection to the hub (WebSocket in v1).
 * This is NOT a poller — only the hub polls the platform; the channel just keeps
 * one hub link over which the hub pushes inbound messages and the session sends
 * replies. Frames are JSON objects discriminated by `type`.
 */

// ── session → hub ───────────────────────────────────────────────────────────

/** First frame a session sends: authenticate + declare identity + version. */
export const registerFrameSchema = z.object({
  type: z.literal("register"),
  /** Protocol major version the session speaks; hub enforces compatibility. */
  protocolVersion: z.number().int().positive(),
  /** Logical agent name (e.g. "re-infra"); usually the repo's working-dir basename. */
  agent: z.string().min(1),
  /** Shared secret; the hub rejects registrations that don't present it. */
  secret: z.string().min(1),
});
export type RegisterFrame = z.infer<typeof registerFrameSchema>;

/** A reply the session wants delivered back out through the hub. */
export const replyFrameSchema = z.object({
  type: z.literal("reply"),
  /** Room to deliver into (echoes the inbound's room for normal replies). */
  room: z.string().min(1),
  text: z.string(),
  /** Agent names tagged in the reply; drives agent→agent re-injection. */
  mentions: z.array(z.string().min(1)).default([]),
  replyToId: z.string().optional(),
  /**
   * Request that this (short) reply is also rendered as a voice note. Honored only
   * when TTS is enabled and the text is speakable (the hub skips code/links/long
   * text); the text is always the source of truth. Human-facing only — agent→agent
   * re-injection stays text.
   */
  voice: z.boolean().optional(),
});
export type ReplyFrame = z.infer<typeof replyFrameSchema>;

/**
 * A file the session wants delivered out to a room (agent → operator/room). The
 * channel reads the agent's local file and sends the bytes here; the hub hands
 * them to the adapter to upload. Files are human-facing — no agent→agent routing.
 */
export const sendFileFrameSchema = z.object({
  type: z.literal("send_file"),
  room: z.string().min(1),
  file: filePayloadSchema,
  caption: z.string().optional(),
});
export type SendFileFrame = z.infer<typeof sendFileFrameSchema>;

/** Liveness keepalive; the hub may use it to detect dead sessions. */
export const heartbeatFrameSchema = z.object({
  type: z.literal("heartbeat"),
});
export type HeartbeatFrame = z.infer<typeof heartbeatFrameSchema>;

export const sessionToHubFrameSchema = z.discriminatedUnion("type", [
  registerFrameSchema,
  replyFrameSchema,
  sendFileFrameSchema,
  heartbeatFrameSchema,
]);
export type SessionToHubFrame = z.infer<typeof sessionToHubFrameSchema>;

// ── hub → session ───────────────────────────────────────────────────────────

/** Whether the hub can voice replies, and the cap above which it posts text (#74). */
export const voiceReplyCapsSchema = z.object({
  enabled: z.boolean(),
  maxChars: z.number().int().positive(),
});
export type VoiceReplyCapsFrame = z.infer<typeof voiceReplyCapsSchema>;

/** Registration accepted; confirms the negotiated version + effective settings. */
export const registeredFrameSchema = z.object({
  type: z.literal("registered"),
  agent: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  /**
   * Voice-reply capability, so the channel can tell the sending agent — in the
   * `reply` tool result — when a `voice: true` reply won't be voiced (too long /
   * unspeakable). Absent from older hubs; the channel then can't predict and
   * reports voice optimistically.
   */
  voiceReply: voiceReplyCapsSchema.optional(),
});
export type RegisteredFrame = z.infer<typeof registeredFrameSchema>;

/**
 * An inbound message pushed to the session for injection. `coordinationThread`
 * ties agent↔agent hops to a loop-governor budget; present when routing inside a
 * coordination thread. When `message.fromKind === "agent"` the receiver should
 * treat it as a peer request, not a human directive.
 */
export const inboundFrameSchema = z.object({
  type: z.literal("inbound"),
  message: inboundMessageSchema,
  coordinationThread: z.string().optional(),
  /**
   * File bytes accompanying the message (an operator photo/document). Present only
   * when the inbound carried an attachment; the channel materializes it to a local
   * path for the session. `message.text` holds any caption; `message.attachments`
   * names the file.
   */
  file: filePayloadSchema.optional(),
});
export type InboundFrame = z.infer<typeof inboundFrameSchema>;

/** Machine-readable reasons a frame or the connection was rejected. */
export const errorCodeSchema = z.enum([
  "version_mismatch",
  "auth_failed",
  "unknown_agent",
  "not_allowlisted",
  "bad_request",
  "name_in_use",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** An error from the hub. `fatal` means the connection is being closed. */
export const errorFrameSchema = z.object({
  type: z.literal("error"),
  code: errorCodeSchema,
  message: z.string(),
  fatal: z.boolean().default(false),
});
export type ErrorFrame = z.infer<typeof errorFrameSchema>;

export const hubToSessionFrameSchema = z.discriminatedUnion("type", [
  registeredFrameSchema,
  inboundFrameSchema,
  errorFrameSchema,
]);
export type HubToSessionFrame = z.infer<typeof hubToSessionFrameSchema>;

/** Any frame on the wire, either direction — useful for generic parsing/logging. */
export const wireFrameSchema = z.union([
  sessionToHubFrameSchema,
  hubToSessionFrameSchema,
]);
export type WireFrame = z.infer<typeof wireFrameSchema>;
