import { Bot } from "grammy";
import type { Logger } from "../../logger.js";
import type { SendOptions, TelegramApi, TgMessage } from "./types.js";

/**
 * grammY-backed {@link TelegramApi}. This is the only file that touches grammY;
 * it stays thin so the adapter's routing logic can be tested without it. grammY
 * owns the single `getUpdates` long-poll (so exactly one process holds the token)
 * and reconnection.
 */
export class GrammyApi implements TelegramApi {
  private readonly bot: Bot;

  constructor(
    token: string,
    private readonly logger?: Logger,
  ) {
    this.bot = new Bot(token);
    this.bot.catch((err) => {
      this.logger?.("warn", "grammy runtime error", { error: String(err.error) });
    });
  }

  onMessage(handler: (msg: TgMessage) => void): void {
    this.bot.on("message:text", (ctx) => {
      const msg: TgMessage = {
        message_id: ctx.message.message_id,
        chat: { id: ctx.chat.id, type: ctx.chat.type },
        text: ctx.message.text,
        from: ctx.from
          ? { id: ctx.from.id, is_bot: ctx.from.is_bot, username: ctx.from.username }
          : undefined,
        ...(ctx.message.reply_to_message
          ? { reply_to_message: { message_id: ctx.message.reply_to_message.message_id } }
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

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
