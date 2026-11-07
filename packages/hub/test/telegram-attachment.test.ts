import { describe, it, expect } from "vitest";
import { attachmentOf, droppedMediaOf } from "../src/adapters/telegram/attachment.js";

describe("attachmentOf (#120)", () => {
  it("takes the largest photo size with a synthesized name and mime", () => {
    expect(
      attachmentOf({
        message_id: 7,
        photo: [
          { file_id: "small", file_size: 10 },
          { file_id: "big", file_size: 99 },
        ],
      }),
    ).toEqual({ fileId: "big", filename: "photo_7.jpg", mimeType: "image/jpeg", fileSize: 99 });
  });

  it("keeps a document's own name and mime", () => {
    expect(
      attachmentOf({
        message_id: 1,
        document: { file_id: "d", file_name: "notes.pdf", mime_type: "application/pdf", file_size: 5 },
      }),
    ).toEqual({ fileId: "d", filename: "notes.pdf", mimeType: "application/pdf", fileSize: 5 });
  });

  it("treats an audio file (Telegram Desktop's .ogg/.mp3) as an attachment", () => {
    expect(
      attachmentOf({
        message_id: 3,
        audio: { file_id: "a", file_name: "dictation.ogg", mime_type: "audio/ogg", file_size: 9_240_784 },
      }),
    ).toEqual({ fileId: "a", filename: "dictation.ogg", mimeType: "audio/ogg", fileSize: 9_240_784 });
  });

  it("names an audio file without a file_name", () => {
    expect(attachmentOf({ message_id: 3, audio: { file_id: "a" } })).toEqual({
      fileId: "a",
      filename: "audio_3",
      mimeType: "audio/mpeg",
    });
  });

  it("treats a video as an attachment", () => {
    expect(
      attachmentOf({ message_id: 4, video: { file_id: "v", file_name: "demo.mov", mime_type: "video/quicktime" } }),
    ).toEqual({ fileId: "v", filename: "demo.mov", mimeType: "video/quicktime" });
  });

  it("treats a round video note (no name/mime in the Bot API) as an attachment", () => {
    expect(attachmentOf({ message_id: 5, video_note: { file_id: "vn", file_size: 1000 } })).toEqual({
      fileId: "vn",
      filename: "video_note_5.mp4",
      mimeType: "video/mp4",
      fileSize: 1000,
    });
  });

  it("prefers animation over the backward-compat document it also sets", () => {
    expect(
      attachmentOf({
        message_id: 6,
        animation: { file_id: "an", file_name: "fun.mp4", mime_type: "video/mp4" },
        document: { file_id: "an", file_name: "fun.mp4", mime_type: "video/mp4" },
      }),
    ).toEqual({ fileId: "an", filename: "fun.mp4", mimeType: "video/mp4" });
  });

  it("returns nothing for a text-only message", () => {
    expect(attachmentOf({ message_id: 8 })).toBeUndefined();
  });
});

describe("droppedMediaOf (#120)", () => {
  it("names a sticker, which the hub doesn't deliver", () => {
    expect(droppedMediaOf({ message_id: 1, sticker: { file_id: "s" } })).toBe("sticker");
  });

  it("is undefined when the file is delivered", () => {
    expect(droppedMediaOf({ message_id: 1, audio: { file_id: "a" } })).toBeUndefined();
  });

  it("is undefined for a plain message", () => {
    expect(droppedMediaOf({ message_id: 1 })).toBeUndefined();
  });
});
