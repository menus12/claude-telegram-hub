import { describe, it, expect } from "vitest";
import type { FilePayload, InboundMessage } from "@claude-telegram-hub/protocol";
import { TelegramAdapter } from "../src/adapters/telegram/adapter.js";
import type { TgMessage } from "../src/adapters/telegram/types.js";
import { FakeTelegramApi } from "./fake-telegram.js";
import { delay } from "./helpers.js";

async function adapterWithInbox() {
  const api = new FakeTelegramApi();
  const adapter = new TelegramAdapter({ api, tagSigil: "@" });
  const received: { message: InboundMessage; file?: FilePayload }[] = [];
  await adapter.start((message, file) => {
    received.push({ message, file });
    return Promise.resolve();
  });
  return { api, adapter, received };
}

const photoMsg = (over: Partial<TgMessage> = {}): TgMessage => ({
  message_id: 5,
  chat: { id: -100, type: "supergroup" },
  from: { id: 42, is_bot: false },
  caption: "@re-infra look at this",
  attachment: { fileId: "f1", filename: "shot.png", mimeType: "image/png", fileSize: 8 },
  ...over,
});

describe("Telegram inbound files", () => {
  it("downloads a tagged photo's bytes and hands them to the hub as a file", async () => {
    const { api, received } = await adapterWithInbox();
    api.setFile("f1", Buffer.from("PNG-BYTES"));
    api.push(photoMsg());
    await delay(10);

    expect(received).toHaveLength(1);
    expect(received[0].message.text).toBe("@re-infra look at this");
    expect(received[0].message.mentions).toEqual(["re-infra"]);
    expect(received[0].message.attachments).toEqual(["shot.png"]);
    expect(received[0].file).toEqual({
      filename: "shot.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("PNG-BYTES").toString("base64"),
    });
  });

  it("does not download an untagged file (no one to route it to)", async () => {
    const { api, received } = await adapterWithInbox();
    api.setFile("f1", Buffer.from("PNG-BYTES"));
    api.push(photoMsg({ caption: undefined })); // no caption → no mention
    await delay(10);

    expect(received).toHaveLength(1);
    expect(received[0].message.mentions).toEqual([]);
    expect(received[0].file).toBeUndefined();
  });

  it("routes a tagged file with an empty caption and still fetches it", async () => {
    const { api, received } = await adapterWithInbox();
    api.setFile("f1", Buffer.from("X"));
    api.push(photoMsg({ caption: "@re-infra" }));
    await delay(10);
    expect(received[0].message.mentions).toEqual(["re-infra"]);
    expect(received[0].file?.filename).toBe("shot.png");
  });

  it("skips an over-limit file and annotates the message instead", async () => {
    const { api, received } = await adapterWithInbox();
    api.push(
      photoMsg({
        caption: "@re-infra big one",
        attachment: {
          fileId: "huge",
          filename: "dump.bin",
          mimeType: "application/octet-stream",
          fileSize: 21 * 1024 * 1024, // > the 20 MB Bot API download limit
        },
      }),
    );
    await delay(10);
    expect(received[0].file).toBeUndefined();
    expect(received[0].message.text).toContain("too large to fetch");
  });

  it("annotates when the download fails (no bytes available)", async () => {
    const { api, received } = await adapterWithInbox();
    // f1 has no registered bytes → downloadFile returns undefined.
    api.push(photoMsg());
    await delay(10);
    expect(received[0].file).toBeUndefined();
    expect(received[0].message.text).toContain("could not be fetched");
  });
});

describe("Telegram outbound files", () => {
  const b64 = (s: string): FilePayload["dataBase64"] => Buffer.from(s).toString("base64");

  it("sends an image as a photo with an attributed caption", async () => {
    const { api, adapter } = await adapterWithInbox();
    await adapter.sendFile(
      { adapter: "telegram", room: "-100" },
      { agent: "re-infra", file: { filename: "a.png", mimeType: "image/png", dataBase64: b64("img") }, caption: "here" },
    );
    expect(api.sentFiles).toHaveLength(1);
    expect(api.sentFiles[0]).toMatchObject({ kind: "photo", filename: "a.png", chatId: "-100" });
    expect(api.sentFiles[0].opts?.caption).toBe("re-infra ▸ here");
    expect(api.sentFiles[0].bytes.toString()).toBe("img");
  });

  it("sends a non-image as a document, captioned with the filename when no caption", async () => {
    const { api, adapter } = await adapterWithInbox();
    await adapter.sendFile(
      { adapter: "telegram", room: "-100" },
      { agent: "re-infra", file: { filename: "notes.pdf", mimeType: "application/pdf", dataBase64: b64("pdf") } },
    );
    expect(api.sentFiles[0]).toMatchObject({ kind: "document", filename: "notes.pdf" });
    expect(api.sentFiles[0].opts?.caption).toBe("re-infra ▸ notes.pdf");
  });

  it("sends a large image as a document (over the photo size cap)", async () => {
    const { api, adapter } = await adapterWithInbox();
    const bytes = Buffer.alloc(11 * 1024 * 1024, 1); // > 10 MB
    await adapter.sendFile(
      { adapter: "telegram", room: "-100" },
      { agent: "re-infra", file: { filename: "huge.png", mimeType: "image/png", dataBase64: bytes.toString("base64") } },
    );
    expect(api.sentFiles[0].kind).toBe("document");
  });
});
