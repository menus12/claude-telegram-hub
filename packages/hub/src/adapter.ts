import type {
  FilePayload,
  InboundMessage,
  OutboundFile,
  OutboundMessage,
  RouteTarget,
} from "@claude-telegram-hub/protocol";

/**
 * Called by an adapter to hand a normalized inbound message to the hub. An
 * accompanying `file` (an operator photo/document) is passed alongside the
 * message; the hub streams the bytes on to the tagged session's channel.
 */
export type Inbox = (message: InboundMessage, file?: FilePayload, meta?: InboundMeta) => Promise<void>;

/**
 * Adapter-side facts about an inbound message that the hub needs but that never
 * travel to a session (so they aren't part of the wire `InboundMessage`).
 */
export interface InboundMeta {
  /** The message was forwarded (it carries no address of its own) (#109). */
  forwarded?: boolean;
  /**
   * Why a voice note's transcript is empty when transcription itself failed
   * (timeout, STT error, download failure) — as opposed to a clean but empty
   * transcript (silence/noise). Lets the hub say "transcription failed" (#109).
   */
  transcriptionError?: string;
}

/**
 * A voiced reply: synthesized audio plus the speaking agent and the full reply
 * `text` (which becomes the voice note's attributed caption — the source of truth).
 */
export interface OutboundVoice {
  agent: string;
  audio: Buffer;
  mimeType: string;
  text: string;
  /** Platform user ids to mention as the operator (id-link fallback) — see OutboundMessage (#94). */
  mentionUserIds?: string[];
  /** Operator `@username`s to mention (breaks a muted chat) — see OutboundMessage (#94). */
  mentionUsernames?: string[];
}

/**
 * The pluggable transport seam. The hub core is adapter-agnostic: it never
 * imports anything platform-specific. Each transport (telegram, later teams /
 * slack) implements this one interface.
 */
export interface TransportAdapter {
  /** Stable adapter id, e.g. "telegram" | "loopback". */
  readonly name: string;
  /** Begin producing inbound messages into `inbox`. */
  start(inbox: Inbox): Promise<void>;
  /** Deliver an outbound message to a platform target. */
  send(target: RouteTarget, out: OutboundMessage): Promise<void>;
  /** Deliver a file (with optional caption) to a platform target. */
  sendFile(target: RouteTarget, out: OutboundFile): Promise<void>;
  /** Deliver a voiced reply (a captioned voice note) to a platform target. */
  sendVoice(target: RouteTarget, out: OutboundVoice): Promise<void>;
  /** Stop producing messages and release resources. */
  stop(): Promise<void>;
}
