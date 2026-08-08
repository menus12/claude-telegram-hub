import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import type { SynthesisService } from "../src/index.js";
import { FakeSynthesisService } from "./fake-synthesizer.js";
import { waitFor, delay } from "./helpers.js";

function hubConfig() {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "user1",
    HUB_BIND_HOST: "127.0.0.1",
    HUB_BIND_PORT: "0",
    HUB_ADAPTER: "loopback",
    HUB_LOG_LEVEL: "error",
  });
}

function channelConfig(url: string, agent: string): ChannelConfig {
  return {
    hubUrl: url,
    sessionSecret: "s3cr3t",
    agent,
    logLevel: "error",
    reconnectInitialMs: 30,
    reconnectMaxMs: 120,
    maxFileMb: 50,
  };
}

let hub: Hub | undefined;
const clients: HubClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  if (hub) await hub.stop();
  hub = undefined;
});

type LogCall = { level: string; msg: string };

async function startHub(
  synth?: SynthesisService,
  logs?: LogCall[],
): Promise<{ adapter: LoopbackAdapter; url: string }> {
  const adapter = new LoopbackAdapter();
  const logger = logs ? (level: string, msg: string) => logs.push({ level, msg }) : () => {};
  hub = new Hub({ config: hubConfig(), adapter, logger, ...(synth ? { synth } : {}) });
  await hub.start();
  return { adapter, url: `ws://127.0.0.1:${hub.port()}` };
}

function attach(url: string, agent: string) {
  let registered = false;
  const client = new HubClient(channelConfig(url, agent), {
    onInbound: () => {},
    onRegistered: () => {
      registered = true;
    },
  });
  clients.push(client);
  client.start();
  return { client, registered: () => registered };
}

describe("voiced replies (TTS)", () => {
  it("sends a short voice:true reply as a captioned voice note (not text)", async () => {
    const synth = new FakeSynthesisService();
    const { adapter, url } = await startHub(synth);
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "done, deployed to prod", voice: true });
    await waitFor(() => adapter.sentVoices.length >= 1);
    expect(adapter.sentVoices[0].out).toMatchObject({ agent: "platform", text: "done, deployed to prod" });
    expect(synth.calls[0]).toBe("done, deployed to prod"); // spoken text
    await delay(20);
    expect(adapter.sent).toHaveLength(0); // no separate text copy
  });

  it("speaks voiceText when given, keeping text as the caption (#68)", async () => {
    const synth = new FakeSynthesisService();
    const { adapter, url } = await startHub(synth);
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({
      room: "-100",
      text: "Done — deployed abc123 to prod, logs at https://logs.example/x",
      voice: true,
      voiceText: "Done, deployed to prod.",
    });
    await waitFor(() => adapter.sentVoices.length >= 1);
    expect(synth.calls[0]).toBe("Done, deployed to prod."); // spoke voiceText
    // caption is the full displayed text (source of truth), not voiceText
    expect(adapter.sentVoices[0].out.text).toContain("abc123");
  });

  it("falls back to text when the reply isn't speakable (code)", async () => {
    const synth = new FakeSynthesisService();
    const { adapter, url } = await startHub(synth);
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "```\nnpm ci && npm run build\n```", voice: true });
    await waitFor(() => adapter.sent.length >= 1);
    expect(adapter.sent[0].out.text).toContain("npm ci");
    expect(adapter.sentVoices).toHaveLength(0);
    expect(synth.calls).toHaveLength(0); // never synthesized
  });

  it("logs why a voiced reply fell back to text — unspeakable (#67)", async () => {
    const logs: LogCall[] = [];
    const synth = new FakeSynthesisService();
    const { adapter, url } = await startHub(synth, logs);
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "```\nnpm ci\n```", voice: true });
    await waitFor(() => adapter.sent.length >= 1);
    expect(logs.some((l) => l.msg.includes("not speakable"))).toBe(true);
    expect(synth.calls).toHaveLength(0);
  });

  it("logs why a voiced reply fell back to text — TTS disabled (#67)", async () => {
    const logs: LogCall[] = [];
    const { adapter, url } = await startHub(undefined, logs); // no synth
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "all green", voice: true });
    await waitFor(() => adapter.sent.length >= 1);
    expect(logs.some((l) => l.msg.includes("TTS is disabled"))).toBe(true);
  });

  it("falls back to text when synthesis fails", async () => {
    const synth = new FakeSynthesisService(() => {
      throw new Error("tts down");
    });
    const { adapter, url } = await startHub(synth);
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "all green", voice: true });
    await waitFor(() => adapter.sent.length >= 1);
    expect(adapter.sentVoices).toHaveLength(0);
  });

  it("falls back to text when the audio isn't a voice-note format", async () => {
    const synth = new FakeSynthesisService({ audio: Buffer.from("mp3"), mimeType: "audio/mpeg" });
    const { adapter, url } = await startHub(synth);
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "all green", voice: true });
    await waitFor(() => adapter.sent.length >= 1);
    expect(adapter.sentVoices).toHaveLength(0);
  });

  it("ignores voice:true when TTS isn't enabled", async () => {
    const { adapter, url } = await startHub(); // no synth
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "all green", voice: true });
    await waitFor(() => adapter.sent.length >= 1);
    expect(adapter.sentVoices).toHaveLength(0);
  });

  it("a normal reply (no voice) is still text", async () => {
    const synth = new FakeSynthesisService();
    const { adapter, url } = await startHub(synth);
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "hello" });
    await waitFor(() => adapter.sent.length >= 1);
    expect(adapter.sentVoices).toHaveLength(0);
    expect(synth.calls).toHaveLength(0);
  });
});
