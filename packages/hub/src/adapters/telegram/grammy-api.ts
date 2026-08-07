import { Bot, InputFile } from "grammy";
import type { Message } from "grammy/types";
import type { Logger } from "../../logger.js";
import type {
  OutgoingFile,
  SendFileOptions,
  SendOptions,
  TelegramApi,
  TgAttachment,
  TgMessage,
} from "./types.js";

/** Extract a normalized attachment from a Telegram message, if it carries one. */
function attachmentOf(msg: Message): TgAttachment | undefined {
  if (msg.photo && msg.photo.length > 0) {
    // photo is an array of sizes; the last is the largest.
    const largest = msg.photo[msg.photo.length - 1];
    return {
      fileId: largest.file_id,
      filename: `photo_${msg.message_id}.jpg`,
      mimeType: "image/jpeg",
      ...(largest.file_size !== undefined ? { fileSize: largest.file_size } : {}),
    };
  }
  if (msg.document) {
    const d = msg.document;
    return {
      fileId: d.file_id,
      filename: d.file_name ?? `document_${msg.message_id}`,
      mimeType: d.mime_type ?? "application/octet-stream",
      ...(d.file_size !== undefined ? { fileSize: d.file_size } : {}),
    };
  }
  return undefined;
}

/**
 * grammY-backed {@link TelegramApi}. This is the only file that touches grammY;
 * it stays thin so the adapter's routing logic can be tested without it. grammY
 * owns the single `getUpdates` long-poll (so exactly one process holds the token)
 * and reconnection.
 */
export class GrammyApi implements TelegramApi {
  private readonly bot: Bot;

  constructor(
    private readonly token: string,
    private readonly logger?: Logger,
  ) {
    this.bot = new Bot(token);
    this.bot.catch((err) => {
      this.logger?.("warn", "grammy runtime error", { error: String(err.error) });
    });
  }

  onMessage(handler: (msg: TgMessage) => void): void {
    // One handler for every message type; text, caption, and photo/document
    // attachments are normalized here. Unsupported types yield a message with
    // none of these, which normalization drops.
    this.bot.on("message", (ctx) => {
      const m = ctx.message;
      const attachment = attachmentOf(m);
      const msg: TgMessage = {
        message_id: m.message_id,
        chat: { id: ctx.chat.id, type: ctx.chat.type },
        from: ctx.from
          ? { id: ctx.from.id, is_bot: ctx.from.is_bot, username: ctx.from.username }
          : undefined,
        ...(m.text !== undefined ? { text: m.text } : {}),
        ...(m.caption !== undefined ? { caption: m.caption } : {}),
        ...(attachment ? { attachment } : {}),
        ...(m.reply_to_message
          ? {
              reply_to_message: {
                message_id: m.reply_to_message.message_id,
                // The visible text of the replied-to message (no markup); its
                // `agent ▸ …` prefix identifies the author when the index misses.
                ...("text" in m.reply_to_message && typeof m.reply_to_message.text === "string"
                  ? { text: m.reply_to_message.text }
                  : {}),
              },
            }
          : {}),
      };
      handler(msg);
    });
  }

  start(): Promise<void> {
    // bot.start() resolves only when polling stops, so we don't await it here.
    void this.bot.start().catch((err: unknown) => {
      this.logger?.("error", "telegram long-poll failed to start", {
        error: String(err),
      });
    });
    return Promise.resolve();
  }

  async sendMessage(
    chatId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<number | undefined> {
    const sent = await this.bot.api.sendMessage(chatId, text, {
      ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts?.replyToMessageId
        ? { reply_parameters: { message_id: opts.replyToMessageId } }
        : {}),
    });
    return sent.message_id;
  }

  async downloadFile(fileId: string): Promise<Buffer | undefined> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return undefined;
      // The file download URL carries the bot token, so it never leaves the hub —
      // the hub fetches the bytes here and streams them to the session's channel.
      const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) {
        this.logger?.("warn", "telegram file download failed", { status: res.status });
        return undefined;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      this.logger?.("warn", "telegram getFile failed", { error: String(err) });
      return undefined;
    }
  }

  async sendPhoto(
    chatId: string,
    file: OutgoingFile,
    opts?: SendFileOptions,
  ): Promise<number | undefined> {
    const sent = await this.bot.api.sendPhoto(chatId, new InputFile(file.bytes, file.filename), {
      ...(opts?.caption ? { caption: opts.caption } : {}),
      ...(opts?.replyToMessageId
        ? { reply_parameters: { message_id: opts.replyToMessageId } }
        : {}),
    });
    return sent.message_id;
  }

  async sendDocument(
    chatId: string,
    file: OutgoingFile,
    opts?: SendFileOptions,
  ): Promise<number | undefined> {
    const sent = await this.bot.api.sendDocument(chatId, new InputFile(file.bytes, file.filename), {
      ...(opts?.caption ? { caption: opts.caption } : {}),
      ...(opts?.replyToMessageId
        ? { reply_parameters: { message_id: opts.replyToMessageId } }
        : {}),
    });
    return sent.message_id;
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
