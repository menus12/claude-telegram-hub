/**
 * The minimal Telegram surface the adapter needs, abstracted behind an
 * interface so the adapter logic is testable without a live bot token. The
 * grammY-backed implementation lives in `grammy-api.ts`; tests supply a fake.
 */

export type TgChatType = "private" | "group" | "supergroup" | "channel";

/**
 * A normalized attachment on an inbound message. grammY maps Telegram's photo /
 * document shapes onto this single form (largest photo size; synthesized name /
 * mime for photos) so the rest of the adapter handles one attachment type.
 */
export interface TgAttachment {
  /** Telegram file id, resolved to bytes via `downloadFile`. */
  fileId: string;
  filename: string;
  mimeType: string;
  /** Size in bytes if Telegram reported it (used to skip over-limit fetches). */
  fileSize?: number;
}

/** A normalized-enough Telegram message (a subset of the Bot API shape). */
export interface TgMessage {
  message_id: number;
  chat: { id: number; type: TgChatType };
  from?: { id: number; is_bot: boolean; username?: string };
  text?: string;
  /** Caption on a photo/document message (routed like `text`). */
  caption?: string;
  /** A photo or document attached to the message, normalized. */
  attachment?: TgAttachment;
  /**
   * The message this one replies to, if any. The bot sends everything, so
   * `reply_to_message.from` is always the bot and can't identify the agent; the
   * agent is recovered from the adapter's message-id index (fast path) or, so it
   * survives a restart, from the attributed `text` (`agent ▸ …`).
   */
  reply_to_message?: { message_id: number; text?: string };
}

export interface SendOptions {
  replyToMessageId?: number;
  /** Telegram parse mode for the text (e.g. "MarkdownV2"); omit for plain text. */
  parseMode?: "MarkdownV2" | "HTML" | "Markdown";
}

/** A file leaving through the adapter: raw bytes plus the name to send them under. */
export interface OutgoingFile {
  bytes: Buffer;
  filename: string;
}

export interface SendFileOptions {
  /** Plain-text caption (no parse mode, to avoid entity-parse failures). */
  caption?: string;
  replyToMessageId?: number;
}

/** The transport primitives the adapter drives; grammY implements these. */
export interface TelegramApi {
  /** Register the handler invoked for each inbound message. */
  onMessage(handler: (msg: TgMessage) => void): void;
  /** Begin long-polling `getUpdates` (the sole consumer of the bot token). */
  start(): Promise<void>;
  /**
   * Send a message, returning the sent Telegram `message_id` so the adapter can
   * index it for reply-to routing (`undefined` if the platform didn't report one).
   */
  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<number | undefined>;
  /** Fetch an attachment's bytes by file id (`undefined` if unavailable/too large). */
  downloadFile(fileId: string): Promise<Buffer | undefined>;
  /** Send an image as a Telegram photo. */
  sendPhoto(chatId: string, file: OutgoingFile, opts?: SendFileOptions): Promise<number | undefined>;
  /** Send any file as a Telegram document. */
  sendDocument(
    chatId: string,
    file: OutgoingFile,
    opts?: SendFileOptions,
  ): Promise<number | undefined>;
  stop(): Promise<void>;
}
