import { renderOutbound } from "@claude-telegram-hub/protocol";
import type { OutboundMessage, RouteTarget } from "@claude-telegram-hub/protocol";
import type { Inbox, TransportAdapter } from "../../adapter.js";
import type { Logger } from "../../logger.js";
import { toInboundMessage } from "./normalize.js";
import type { TelegramApi, TgMessage } from "./types.js";

export interface TelegramAdapterOptions {
  api: TelegramApi;
  /** Sigil that marks an agent mention (default `@`, from hub config). */
  tagSigil: string;
  logger?: Logger;
}

/**
 * The Telegram transport adapter. It normalizes inbound messages to the hub's
 * shape and renders outbound with the speaking agent's attribution prefix (one
 * bot posts everything). All grammY specifics live behind `TelegramApi`, so the
 * routing logic here is fully testable without a live token.
 */
export class TelegramAdapter implements TransportAdapter {
  readonly name = "telegram";
  private inbox: Inbox | undefined;

  constructor(private readonly opts: TelegramAdapterOptions) {}

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.opts.api.onMessage((msg) => this.handle(msg));
    await this.opts.api.start();
  }

  async send(target: RouteTarget, out: OutboundMessage): Promise<void> {
    const text = renderOutbound(out);
    await this.opts.api.sendMessage(
      target.room,
      text,
      target.replyToId ? { replyToMessageId: Number(target.replyToId) } : undefined,
    );
  }

  async stop(): Promise<void> {
    await this.opts.api.stop();
    this.inbox = undefined;
  }

  private handle(msg: TgMessage): void {
    const message = toInboundMessage(msg, this.opts.tagSigil);
    if (!message) return;
    const inbox = this.inbox;
    if (!inbox) return;
    void inbox(message).catch((err: unknown) => {
      this.opts.logger?.("warn", "failed to hand inbound to hub", {
        error: String(err),
      });
    });
  }
}
