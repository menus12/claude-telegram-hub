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
import type { TranscriptionService } from "../../transcription.js";
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
  /**
   * Speech-to-text for voice notes. When absent, a voice note is still surfaced
   * (marked `voice`, empty text) so the hub can tell the operator voice is off.
   */
  transcriber?: TranscriptionService;
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

  /**
   * Resolve a reply's target agent: the message-id index (fast path, this process),
   * falling back to the author's `agent ▸ …` attribution in the replied-to text
   * (needs no index, so it survives a hub restart / index eviction).
   */
  private resolveReplyTarget(room: string, messageId: number, text?: string): string | undefined {
    return this.replies.resolve(room, messageId) ?? (text ? parseAttribution(text) : undefined);
  }

  private handle(msg: TgMessage): void {
    if (msg.voice) {
      void this.handleVoice(msg).catch((err: unknown) => {
        this.opts.logger?.("warn", "failed to handle voice note", { error: String(err) });
      });
      return;
    }
    const message = toInboundMessage(msg, this.opts.tagSigil, (reply) =>
      this.resolveReplyTarget(reply.room, reply.messageId, reply.text),
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

  /**
   * Transcribe a voice note and hand it to the hub as a `voice`-marked message
   * (text = transcript). Reply-to still addresses (resolved here); spoken-name /
   * broadcast addressing and the transcript echo happen hub-side. With no
   * transcriber configured, or on a fetch/transcribe failure, the text is empty —
   * the hub then tells the operator voice is off / it couldn't make out the note.
   */
  private async handleVoice(msg: TgMessage): Promise<void> {
    const inbox = this.inbox;
    const from = msg.from;
    const voice = msg.voice;
    if (!inbox || !voice || !from || from.is_bot) return;
    const room = String(msg.chat.id);

    const mentions: string[] = [];
    const repliedTo = msg.reply_to_message;
    if (repliedTo) {
      const agent = this.resolveReplyTarget(room, repliedTo.message_id, repliedTo.text);
      if (agent) mentions.push(agent);
    }

    const message: InboundMessage = {
      adapter: "telegram",
      room,
      fromKind: "human",
      fromId: String(from.id),
      text: this.opts.transcriber ? await this.transcribeVoice(voice) : "",
      mentions,
      voice: true,
    };
    await inbox(message);
  }

  /** Fetch a voice note's bytes and transcribe; returns "" on any failure. */
  private async transcribeVoice(voice: NonNullable<TgMessage["voice"]>): Promise<string> {
    if (voice.fileSize !== undefined && voice.fileSize > INBOUND_MAX_BYTES) {
      this.opts.logger?.("warn", "voice note too large to fetch", { fileSize: voice.fileSize });
      return "";
    }
    const bytes = await this.opts.api.downloadFile(voice.fileId);
    if (!bytes) {
      this.opts.logger?.("warn", "voice note download failed");
      return "";
    }
    try {
      const { text } = await (this.opts.transcriber as TranscriptionService).transcribe({
        bytes,
        filename: "voice.ogg",
        mimeType: voice.mimeType,
      });
      this.opts.logger?.("info", "transcribed voice note", {
        bytes: bytes.length,
        chars: text.length,
      });
      return text;
    } catch (err) {
      this.opts.logger?.("warn", "voice transcription failed", { error: String(err) });
      return "";
    }
  }
}

/** Append a bracketed note to message text (keeps any caption the operator sent). */
function annotate(text: string, note: string): string {
  return text ? `${text}\n[${note}]` : `[${note}]`;
}
