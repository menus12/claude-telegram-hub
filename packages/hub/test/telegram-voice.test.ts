import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundFrame, InboundMessage } from "@claude-telegram-hub/protocol";
import { Hub } from "../src/index.js";
import { TelegramAdapter } from "../src/adapters/telegram/adapter.js";
import type { InboundMeta, TranscriptionService } from "../src/index.js";
import type { TgMessage } from "../src/adapters/telegram/types.js";
import { FakeTelegramApi } from "./fake-telegram.js";
import { FakeTranscriptionService } from "./fake-transcriber.js";
import { waitFor, delay } from "./helpers.js";

async function harness(transcriber?: TranscriptionService, getAgents?: () => string[]) {
  const api = new FakeTelegramApi();
  const adapter = new TelegramAdapter({
    api,
    tagSigil: "@",
    ...(transcriber ? { transcriber } : {}),
    ...(getAgents ? { getAgents } : {}),
  });
  const received: InboundMessage[] = [];
  await adapter.start((m) => {
    received.push(m);
    return Promise.resolve();
  });
  return { api, adapter, received };
}

const voiceMsg = (over: Partial<TgMessage> = {}): TgMessage => ({
  message_id: 5,
  chat: { id: -100, type: "supergroup" },
  from: { id: 42, is_bot: false },
  voice: { fileId: "v1", mimeType: "audio/ogg" },
  ...over,
});

describe("Telegram voice notes", () => {
  it("downloads and transcribes a voice note into a voice-marked message", async () => {
    const stt = new FakeTranscriptionService("platform redeploy the service");
    const { api, received } = await harness(stt);
    api.setFile("v1", Buffer.from("OGG-BYTES"));

    api.push(voiceMsg());
    await delay(10);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      fromKind: "human",
      fromId: "42",
      room: "-100",
      text: "platform redeploy the service",
      voice: true,
      mentions: [],
    });
    // the audio was sent to the transcriber
    expect(stt.calls[0].mimeType).toBe("audio/ogg");
    expect(stt.calls[0].bytes.toString()).toBe("OGG-BYTES");
  });

  it("biases transcription with the live agent names (#65)", async () => {
    const stt = new FakeTranscriptionService("conn redeploy");
    const { api } = await harness(stt, () => ["conn", "kb", "platform"]);
    api.setFile("v1", Buffer.from("OGG"));
    api.push(voiceMsg());
    await delay(10);
    expect(stt.options[0]?.prompt).toContain("conn");
    expect(stt.options[0]?.prompt).toContain("kb");
    expect(stt.options[0]?.prompt).toContain("platform");
  });

  it("carries a reply-to address on a voice note (resolved from attribution)", async () => {
    const stt = new FakeTranscriptionService("and the database?");
    const { api, received } = await harness(stt);
    api.setFile("v1", Buffer.from("X"));

    api.push(voiceMsg({ reply_to_message: { message_id: 9, text: "re-infra ▸ done" } }));
    await delay(10);
    expect(received[0].mentions).toEqual(["re-infra"]);
    expect(received[0].text).toBe("and the database?");
  });

  it("surfaces a voice note with empty text when no transcriber is configured", async () => {
    const { api, received } = await harness(); // no transcriber
    api.setFile("v1", Buffer.from("X"));
    api.push(voiceMsg());
    await delay(10);
    expect(received[0]).toMatchObject({ voice: true, text: "", mentions: [] });
  });

  it("yields empty text when the audio can't be downloaded", async () => {
    const stt = new FakeTranscriptionService("should not be used");
    const { api, received } = await harness(stt);
    // no setFile → downloadFile returns undefined
    api.push(voiceMsg());
    await delay(10);
    expect(received[0]).toMatchObject({ voice: true, text: "" });
    expect(stt.calls).toHaveLength(0); // never reached the transcriber
  });

  it("yields empty text when transcription throws", async () => {
    const stt = new FakeTranscriptionService(() => {
      throw new Error("stt down");
    });
    const { api, received } = await harness(stt);
    api.setFile("v1", Buffer.from("X"));
    api.push(voiceMsg());
    await delay(10);
    expect(received[0]).toMatchObject({ voice: true, text: "" });
  });

  it("skips an over-limit voice note (>20 MB) without downloading", async () => {
    const stt = new FakeTranscriptionService("nope");
    const { api, received } = await harness(stt);
    api.push(voiceMsg({ voice: { fileId: "v1", mimeType: "audio/ogg", fileSize: 21 * 1024 * 1024 } }));
    await delay(10);
    expect(received[0].text).toBe("");
    expect(stt.calls).toHaveLength(0);
  });
});

describe("Telegram voice end-to-end (adapter → hub → session)", () => {
  let hub: Hub | undefined;
  const clients: HubClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    if (hub) await hub.stop();
    hub = undefined;
  });

  it("an operator voice note drives the addressed agent and echoes the transcript", async () => {
    const api = new FakeTelegramApi();
    const stt = new FakeTranscriptionService("platform, redeploy the service");
    hub = new Hub({
      config: loadHubConfig({
        HUB_SESSION_SECRET: "s3cr3t",
        HUB_ALLOWLIST: "42",
        HUB_BIND_HOST: "127.0.0.1",
        HUB_BIND_PORT: "0",
        HUB_ADAPTER: "telegram",
        HUB_STT_URL: "http://stt:8000", // enables voice
        HUB_LOG_LEVEL: "error",
      }),
      adapter: new TelegramAdapter({ api, tagSigil: "@", transcriber: stt }),
      logger: () => {},
    });
    await hub.start();
    const url = `ws://127.0.0.1:${hub.port()}`;

    const injected: InboundFrame[] = [];
    let registered = false;
    const cfg: ChannelConfig = {
      hubUrl: url,
      sessionSecret: "s3cr3t",
      agent: "platform",
      logLevel: "error",
      reconnectInitialMs: 30,
      reconnectMaxMs: 120,
      maxFileMb: 50,
    };
    const client = new HubClient(cfg, {
      onInbound: (f) => injected.push(f),
      onRegistered: () => {
        registered = true;
      },
    });
    clients.push(client);
    client.start();
    await waitFor(() => registered);

    api.setFile("v1", Buffer.from("OGG"));
    api.push({
      message_id: 7,
      chat: { id: 555, type: "private" },
      from: { id: 42, is_bot: false },
      voice: { fileId: "v1", mimeType: "audio/ogg" },
    });

    await waitFor(() => injected.length >= 1);
    expect(injected[0].message.text).toBe("platform, redeploy the service");
    expect(injected[0].message.mentions).toContain("platform");
    // the transcript echo went back to the chat
    await waitFor(() => api.sent.some((s) => s.text.includes("heard")));
  });
});

describe("forwarded messages and STT failures (#109)", () => {
  async function metaHarness(transcriber: TranscriptionService, now: () => number) {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@", transcriber, now });
    const received: { message: InboundMessage; meta?: InboundMeta }[] = [];
    await adapter.start((message, _file, meta) => {
      received.push({ message, meta });
      return Promise.resolve();
    });
    return { api, received };
  }
  const comment = (text: string, over: Partial<TgMessage> = {}): TgMessage => ({
    message_id: 4,
    chat: { id: -100, type: "supergroup" },
    from: { id: 42, is_bot: false },
    text,
    ...over,
  });

  it("a forwarded voice note inherits the address of the comment sent just before it", async () => {
    let t = 0;
    const { api, received } = await metaHarness(new FakeTranscriptionService("long dictation"), () => t);
    api.setFile("v1", Buffer.from("OGG"));
    api.push(comment("@materials see the forwarded note"));
    t = 2_000;
    api.push(voiceMsg({ forwarded: true }));
    await waitFor(() => received.length >= 2);
    expect(received[1].message.mentions).toEqual(["materials"]);
    expect(received[1].meta).toEqual({ forwarded: true });
  });

  it("does not inherit from a stale comment, another sender, or for a non-forward", async () => {
    let t = 0;
    const { api, received } = await metaHarness(new FakeTranscriptionService("x"), () => t);
    api.setFile("v1", Buffer.from("OGG"));
    api.push(comment("@materials hi"));
    api.push(voiceMsg({ forwarded: true, from: { id: 7, is_bot: false } })); // another sender
    api.push(voiceMsg()); // not forwarded
    t = 10_001;
    api.push(voiceMsg({ forwarded: true })); // too late
    await waitFor(() => received.length >= 4);
    expect(received.slice(1).map((r) => r.message.mentions)).toEqual([[], [], []]);
  });

  it("a forwarded file inherits the comment's address too (and is fetched)", async () => {
    const { api, received } = await metaHarness(new FakeTranscriptionService(""), () => 0);
    api.setFile("f1", Buffer.from("DOC"));
    api.push(comment("@infra logs attached"));
    api.push(
      comment("", {
        message_id: 5,
        text: undefined,
        forwarded: true,
        attachment: { fileId: "f1", filename: "log.txt", mimeType: "text/plain", fileSize: 3 },
      }),
    );
    await waitFor(() => received.length >= 2);
    expect(received[1].message.mentions).toEqual(["infra"]);
  });

  it("reports why transcription failed instead of an empty transcript", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const stt = new FakeTranscriptionService(() => {
      throw timeout;
    });
    const { api, received } = await metaHarness(stt, () => 0);
    api.setFile("v1", Buffer.from("OGG"));
    api.push(voiceMsg());
    await waitFor(() => received.length >= 1);
    expect(received[0].message.text).toBe("");
    expect(received[0].meta?.transcriptionError).toContain("timed out");
    expect(received[0].meta?.transcriptionError).toContain("HUB_STT_TIMEOUT_MS");
  });
});
