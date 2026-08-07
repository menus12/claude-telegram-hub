/**
 * The minimal Telegram surface the adapter needs, abstracted behind an
 * interface so the adapter logic is testable without a live bot token. The
 * grammY-backed implementation lives in `grammy-api.ts`; tests supply a fake.
 */

export type TgChatType = "private" | "group" | "supergroup" | "channel";

/** A normalized-enough Telegram text message (a subset of the Bot API shape). */
export interface TgMessage {
  message_id: number;
  chat: { id: number; type: TgChatType };
  from?: { id: number; is_bot: boolean; username?: string };
  text?: string;
  /**
   * The message this one replies to, if any. Only its `message_id` matters here:
   * the bot sends everything, so `reply_to_message.from` is always the bot and
   * can't identify the agent — the adapter's own message_id→agent index does.
   */
  reply_to_message?: { message_id: number };
}

export interface SendOptions {
  replyToMessageId?: number;
  /** Telegram parse mode for the text (e.g. "MarkdownV2"); omit for plain text. */
  parseMode?: "MarkdownV2" | "HTML" | "Markdown";
}

/** The transport primitives the adapter drives; grammY implements these. */
export interface TelegramApi {
  /** Register the handler invoked for each inbound text message. */
  onMessage(handler: (msg: TgMessage) => void): void;
  /** Begin long-polling `getUpdates` (the sole consumer of the bot token). */
  start(): Promise<void>;
  /**
   * Send a message, returning the sent Telegram `message_id` so the adapter can
   * index it for reply-to routing (`undefined` if the platform didn't report one).
   */
  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<number | undefined>;
  stop(): Promise<void>;
}
