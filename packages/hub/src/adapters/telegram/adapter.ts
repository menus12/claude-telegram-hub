import { attributionPrefix, parseAttribution, renderOutbound } from "@claude-telegram-hub/protocol";
import type {
  FilePayload,
  InboundMessage,
  OutboundFile,
  OutboundMessage,
  RouteTarget,
} from "@claude-telegram-hub/protocol";
import type { Inbox, TransportAdapter } from "../../adapter.js";
import type { Logger } from "../../logger.js";
import { toTelegramMarkdown } from "./format.js";
import { toInboundMessage } from "./normalize.js";
import { ReplyIndex } from "./reply-index.js";
import type { SendFileOptions, SendOptions, TelegramApi, TgAttachment, TgMessage } from "./types.js";

/** True when a Telegram error is a MarkdownV2 entity-parse failure. */
function isParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't parse entities|parse entities|character.*must be escaped/i.test(msg);
}

const MB = 1024 * 1024;
/** Bot API getFile caps downloads at 20 MB — larger inbound files can't be fetched. */
const INBOUND_MAX_BYTES = 20 * MB;
/** sendPhoto caps at ~10 MB; larger images go as documents (which preserve them). */
const PHOTO_MAX_BYTES = 10 * MB;

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

  async sendFile(target: RouteTarget, out: OutboundFile): Promise<void> {
    const bytes = Buffer.from(out.file.dataBase64, "base64");
    const filename = out.file.filename;
    // Caption carries the speaking agent's attribution; sent plain (no parse mode).
    const captionText = out.caption ?? filename;
    const opts: SendFileOptions = {
      caption: `${attributionPrefix(out.agent)}${captionText}`,
      ...(target.replyToId ? { replyToMessageId: Number(target.replyToId) } : {}),
    };
    // Images go as photos when small enough; everything else (and large images) as
    // documents, which preserve the original file and allow up to ~50 MB.
    const asPhoto = out.file.mimeType.startsWith("image/") && bytes.length <= PHOTO_MAX_BYTES;
    if (asPhoto) {
      await this.opts.api.sendPhoto(target.room, { bytes, filename }, opts);
    } else {
      await this.opts.api.sendDocument(target.room, { bytes, filename }, opts);
    }
  }

  async stop(): Promise<void> {
    await this.opts.api.stop();
    this.inbox = undefined;
  }

  private handle(msg: TgMessage): void {
    const message = toInboundMessage(msg, this.opts.tagSigil, (reply) =>
      // Fast path: the message-id index (this process). Fallback: the author's
      // `agent ▸ …` attribution in the replied-to text, which needs no index and
      // so survives a hub restart / index eviction.
      this.replies.resolve(reply.room, reply.messageId) ??
      (reply.text !== undefined ? parseAttribution(reply.text) : undefined),
    );
    if (!message) return;
    const inbox = this.inbox;
    if (!inbox) return;
    // Only fetch an attachment's bytes when the message is actually routed
    // (tagged an agent) — an untagged file is dropped by the hub anyway, so
    // there's no point downloading up to 20 MB for it.
    const wantsFile = msg.attachment !== undefined && message.mentions.length > 0;
    const deliver = wantsFile
      ? this.resolveFile(msg.attachment as TgAttachment, message).then((file) =>
          inbox(message, file),
        )
      : inbox(message);
    void deliver.catch((err: unknown) => {
      this.opts.logger?.("warn", "failed to hand inbound to hub", {
        error: String(err),
      });
    });
  }

  /**
   * Fetch an attachment's bytes into a `FilePayload`. If it's over the Bot API's
   * 20 MB download limit, or the fetch fails, annotate the message text with a note
   * (so the agent still sees the caption + knows a file was there) and deliver no file.
   */
  private async resolveFile(
    att: TgAttachment,
    message: InboundMessage,
  ): Promise<FilePayload | undefined> {
    if (att.fileSize !== undefined && att.fileSize > INBOUND_MAX_BYTES) {
      this.opts.logger?.("warn", "inbound attachment too large to fetch", {
        filename: att.filename,
        fileSize: att.fileSize,
      });
      message.text = annotate(message.text, `attachment "${att.filename}" is too large to fetch (> 20 MB)`);
      return undefined;
    }
    const bytes = await this.opts.api.downloadFile(att.fileId);
    if (!bytes) {
      this.opts.logger?.("warn", "inbound attachment download failed", { filename: att.filename });
      message.text = annotate(message.text, `attachment "${att.filename}" could not be fetched`);
      return undefined;
    }
    this.opts.logger?.("info", "fetched inbound attachment", {
      filename: att.filename,
      mimeType: att.mimeType,
      bytes: bytes.length,
    });
    return {
      filename: att.filename,
      mimeType: att.mimeType,
      dataBase64: bytes.toString("base64"),
    };
  }
}

/** Append a bracketed note to message text (keeps any caption the operator sent). */
function annotate(text: string, note: string): string {
  return text ? `${text}\n[${note}]` : `[${note}]`;
}
