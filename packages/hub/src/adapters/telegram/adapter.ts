import { renderOutbound } from "@claude-telegram-hub/protocol";
import type { OutboundMessage, RouteTarget } from "@claude-telegram-hub/protocol";
import type { Inbox, TransportAdapter } from "../../adapter.js";
import type { Logger } from "../../logger.js";
import { toTelegramMarkdown } from "./format.js";
import { toInboundMessage } from "./normalize.js";
import { ReplyIndex } from "./reply-index.js";
import type { SendOptions, TelegramApi, TgMessage } from "./types.js";

/** True when a Telegram error is a MarkdownV2 entity-parse failure. */
function isParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't parse entities|parse entities|character.*must be escaped/i.test(msg);
}

export interface TelegramAdapterOptions {
  api: TelegramApi;
  /** Sigil that marks an agent mention (default `@`, from hub config). */
  tagSigil: string;
  logger?: Logger;
  /**
   * Index of sent agent messages, so a Telegram reply to one routes back to that
   * agent. Defaults to a fresh bounded index; inject one to control its clock/bounds.
   */
  replyIndex?: ReplyIndex;
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
  private readonly replies: ReplyIndex;

  constructor(private readonly opts: TelegramAdapterOptions) {
    this.replies = opts.replyIndex ?? new ReplyIndex();
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.opts.api.onMessage((msg) => this.handle(msg));
    await this.opts.api.start();
  }

  async send(target: RouteTarget, out: OutboundMessage): Promise<void> {
    const base: SendOptions = target.replyToId
      ? { replyToMessageId: Number(target.replyToId) }
      : {};
    let sentId: number | undefined;
    try {
      // Render agent markdown as Telegram MarkdownV2 so bold/code/lists/links show.
      sentId = await this.opts.api.sendMessage(target.room, toTelegramMarkdown(out), {
        ...base,
        parseMode: "MarkdownV2",
      });
    } catch (err) {
      if (!isParseError(err)) throw err;
      // Telegram rejected the entities — deliver the message as plain text rather
      // than dropping it.
      this.opts.logger?.("warn", "telegram markdown parse failed; sending plain", {
        error: err instanceof Error ? err.message : String(err),
      });
      sentId = await this.opts.api.sendMessage(target.room, renderOutbound(out), base);
    }
    // Index an agent's reply so a Telegram reply to it routes back to that agent.
    // Notices aren't authored by an agent (kind "notice"), so they're not indexed.
    if (out.kind === "reply" && sentId !== undefined) {
      this.replies.record(target.room, sentId, out.agent);
    }
  }

  async stop(): Promise<void> {
    await this.opts.api.stop();
    this.inbox = undefined;
  }

  private handle(msg: TgMessage): void {
    const message = toInboundMessage(msg, this.opts.tagSigil, (room, id) =>
      this.replies.resolve(room, id),
    );
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
