import type { TgAttachment } from "./types.js";

/** One Telegram file object (the fields every media type shares). */
interface TgFile {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

/**
 * The subset of a Bot API `Message` this module reads. Structural, so it accepts
 * grammY's `Message` and plain test fixtures alike.
 */
export interface TgMediaMessage {
  message_id: number;
  photo?: TgFile[];
  document?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  animation?: TgFile;
  sticker?: TgFile;
  paid_media?: unknown;
  story?: unknown;
}

function fromFile(f: TgFile, fallbackName: string, fallbackMime: string): TgAttachment {
  return {
    fileId: f.file_id,
    filename: f.file_name ?? fallbackName,
    mimeType: f.mime_type ?? fallbackMime,
    ...(f.file_size !== undefined ? { fileSize: f.file_size } : {}),
  };
}

/**
 * Extract a normalized attachment from a Telegram message, if it carries a file
 * the hub delivers. `voice` is deliberately absent: a voice note is transcribed,
 * not delivered as a file (see the adapter's voice path).
 *
 * Telegram Desktop sends an audio file (`.ogg`, `.mp3`, `.m4a`) as `audio` and a
 * video as `video` / `video_note`, so those must count — otherwise the caption is
 * delivered and the file silently vanishes (#120). An `animation` (GIF/MP4) also
 * sets `document` for backward compatibility; checking it first keeps its name
 * and mime.
 */
export function attachmentOf(msg: TgMediaMessage): TgAttachment | undefined {
  const id = msg.message_id;
  if (msg.photo && msg.photo.length > 0) {
    // photo is an array of sizes; the last is the largest.
    const largest = msg.photo[msg.photo.length - 1];
    return fromFile({ ...largest, file_name: undefined, mime_type: undefined }, `photo_${id}.jpg`, "image/jpeg");
  }
  if (msg.animation) return fromFile(msg.animation, `animation_${id}.mp4`, "video/mp4");
  if (msg.document) return fromFile(msg.document, `document_${id}`, "application/octet-stream");
  if (msg.audio) return fromFile(msg.audio, `audio_${id}`, "audio/mpeg");
  if (msg.video) return fromFile(msg.video, `video_${id}.mp4`, "video/mp4");
  // A round video message has no file_name or mime_type in the Bot API.
  if (msg.video_note) return fromFile(msg.video_note, `video_note_${id}.mp4`, "video/mp4");
  return undefined;
}

/**
 * Name the media kind a message carried that {@link attachmentOf} doesn't keep
 * (and that isn't a voice note), so the adapter can log and annotate it rather
 * than drop it silently (#120). `undefined` = nothing was dropped.
 */
export function droppedMediaOf(msg: TgMediaMessage): string | undefined {
  if (attachmentOf(msg)) return undefined;
  if (msg.sticker) return "sticker";
  if (msg.paid_media !== undefined) return "paid media";
  if (msg.story !== undefined) return "story";
  return undefined;
}
