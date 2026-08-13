import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundMessage } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import type { SynthesisService } from "../src/index.js";
import { FakeSynthesisService } from "./fake-synthesizer.js";
import { waitFor, delay } from "./helpers.js";

function hubConfig(extra: Record<string, string> = {}) {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "user1",
    HUB_BIND_HOST: "127.0.0.1",
    HUB_BIND_PORT: "0",
    HUB_ADAPTER: "loopback",
    HUB_LOG_LEVEL: "error",
    ...extra,
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
  cfgExtra: Record<string, string> = {},
): Promise<{ adapter: LoopbackAdapter; url: string }> {
  const adapter = new LoopbackAdapter();
  const logger = logs ? (level: string, msg: string) => logs.push({ level, msg }) : () => {};
  hub = new Hub({ config: hubConfig(cfgExtra), adapter, logger, ...(synth ? { synth } : {}) });
  await hub.start();
  return { adapter, url: `ws://127.0.0.1:${hub.port()}` };
}

function attach(url: string, agent: string) {
  let registered = false;
  let injected = 0;
  const client = new HubClient(channelConfig(url, agent), {
    onInbound: () => {
      injected += 1;
    },
    onRegistered: () => {
      registered = true;
    },
  });
  clients.push(client);
  client.start();
  return { client, registered: () => registered, injected: () => injected };
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

  describe("HUB_TTS_AUTO (#69)", () => {
    it("auto-voices a short speakable reply without voice:true", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth, undefined, { HUB_TTS_AUTO: "on" });
      const a = attach(url, "platform");
      await waitFor(a.registered);

      a.client.sendReply({ room: "-100", text: "all green, deployed" }); // no voice flag
      await waitFor(() => adapter.sentVoices.length >= 1);
      expect(adapter.sentVoices[0].out.text).toBe("all green, deployed");
    });

    it("does not auto-voice a code/unspeakable reply", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth, undefined, { HUB_TTS_AUTO: "on" });
      const a = attach(url, "platform");
      await waitFor(a.registered);

      a.client.sendReply({ room: "-100", text: "```\nnpm ci\n```" });
      await waitFor(() => adapter.sent.length >= 1);
      expect(adapter.sentVoices).toHaveLength(0);
      expect(synth.calls).toHaveLength(0);
    });

    it("voice:false forces text even under auto", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth, undefined, { HUB_TTS_AUTO: "on" });
      const a = attach(url, "platform");
      await waitFor(a.registered);

      a.client.sendReply({ room: "-100", text: "all green", voice: false });
      await waitFor(() => adapter.sent.length >= 1);
      expect(adapter.sentVoices).toHaveLength(0);
      expect(synth.calls).toHaveLength(0);
    });
  });

  describe("per-language voice (#71)", () => {
    async function startBilingual(synth: SynthesisService) {
      return startHub(synth, undefined, {
        HUB_TTS_VOICE: "af_sky",
        HUB_TTS_VOICE_MAP: "en:af_sky,ru:af_ru",
      });
    }

    it("voices an English reply with the EN voice", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startBilingual(synth);
      const a = attach(url, "platform");
      await waitFor(a.registered);

      a.client.sendReply({ room: "-100", text: "all green, deployed", voice: true });
      await waitFor(() => adapter.sentVoices.length >= 1);
      expect(synth.voices[0]).toBe("af_sky");
    });

    it("voices a Russian reply with the RU voice, in the same room", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startBilingual(synth);
      const a = attach(url, "platform");
      await waitFor(a.registered);

      a.client.sendReply({ room: "-100", text: "готово, задеплоил в прод", voice: true });
      await waitFor(() => adapter.sentVoices.length >= 1);
      expect(synth.voices[0]).toBe("af_ru");
    });

    it("uses the hub's default voice when no map is configured", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth); // no map, no HUB_TTS_VOICE
      const a = attach(url, "platform");
      await waitFor(a.registered);

      a.client.sendReply({ room: "-100", text: "готово", voice: true });
      await waitFor(() => adapter.sentVoices.length >= 1);
      expect(synth.voices[0]).toBeUndefined(); // synth falls back to its own default
    });
  });

  describe("per-room /voice on|off (#70)", () => {
    const command = (text: string): InboundMessage => ({
      adapter: "loopback",
      room: "-100",
      fromKind: "human",
      fromId: "user1", // allowlisted in hubConfig
      text,
      mentions: [],
    });

    it("suppresses voiced replies after /voice off and restores on /voice on", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth);
      const a = attach(url, "platform");
      await waitFor(a.registered);

      // baseline: a voice:true reply is voiced
      a.client.sendReply({ room: "-100", text: "one", voice: true });
      await waitFor(() => adapter.sentVoices.length >= 1);

      // operator turns voice off for this room
      await adapter.deliver(command("/voice off"));
      await waitFor(() => adapter.sent.some((s) => s.out.text.includes("Voice replies off")));

      // now a voice:true reply arrives as text, not voice
      a.client.sendReply({ room: "-100", text: "two", voice: true });
      await waitFor(() => adapter.sent.some((s) => s.out.text === "two"));
      expect(adapter.sentVoices).toHaveLength(1); // still just the baseline

      // turn it back on → voiced again
      await adapter.deliver(command("/voice on"));
      await waitFor(() => adapter.sent.some((s) => s.out.text.includes("Voice replies on")));
      a.client.sendReply({ room: "-100", text: "three", voice: true });
      await waitFor(() => adapter.sentVoices.length >= 2);
    });
  });

  describe("HUB_TTS_AUTO=reply-to-voice (#88)", () => {
    const mirror = { HUB_TTS_AUTO: "reply-to-voice", HUB_STT_URL: "http://stt:8000", HUB_VOICE_ECHO: "off" };
    const operatorVoice = (over = {}): InboundMessage => ({
      adapter: "loopback",
      room: "-100",
      fromKind: "human",
      fromId: "user1",
      text: "status?",
      mentions: ["platform"],
      voice: true,
      ...over,
    });

    it("voices a reply that answers an operator voice note", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth, undefined, mirror);
      const a = attach(url, "platform");
      await waitFor(a.registered);

      await adapter.deliver(operatorVoice());
      await waitFor(() => a.injected() >= 1); // the voice note reached the agent

      a.client.sendReply({ room: "-100", text: "all green, deployed" }); // no voice flag
      await waitFor(() => adapter.sentVoices.length >= 1);
    });

    it("does NOT voice a reply to an operator TEXT message", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth, undefined, mirror);
      const a = attach(url, "platform");
      await waitFor(a.registered);

      await adapter.deliver(operatorVoice({ voice: false, text: "@platform status" }));
      await waitFor(() => a.injected() >= 1);

      a.client.sendReply({ room: "-100", text: "all green" });
      await waitFor(() => adapter.sent.some((s) => s.out.text === "all green"));
      expect(adapter.sentVoices).toHaveLength(0);
    });

    it("does NOT voice an agent↔agent reply (last inbound was a peer)", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth, undefined, mirror);
      const a = attach(url, "platform");
      await waitFor(a.registered);

      // a peer message is what platform last saw
      await adapter.deliver({
        adapter: "loopback",
        room: "-100",
        fromKind: "agent",
        fromId: "gitops",
        text: "@platform can you check",
        mentions: ["platform"],
      });
      await waitFor(() => a.injected() >= 1);

      a.client.sendReply({ room: "-100", text: "checked, all good" });
      await waitFor(() => adapter.sent.some((s) => s.out.text === "checked, all good"));
      expect(adapter.sentVoices).toHaveLength(0);
    });

    it("an explicit voice:false still forces text even after an operator voice note", async () => {
      const synth = new FakeSynthesisService();
      const { adapter, url } = await startHub(synth, undefined, mirror);
      const a = attach(url, "platform");
      await waitFor(a.registered);
      await adapter.deliver(operatorVoice());
      await waitFor(() => a.injected() >= 1);

      a.client.sendReply({ room: "-100", text: "all green", voice: false });
      await waitFor(() => adapter.sent.some((s) => s.out.text === "all green"));
      expect(adapter.sentVoices).toHaveLength(0);
    });
  });

  it("/set ttsauto on takes effect live (no restart) — a no-flag reply gets voiced (#config)", async () => {
    const synth = new FakeSynthesisService();
    const { adapter, url } = await startHub(synth); // HUB_TTS_AUTO defaults off
    const a = attach(url, "platform");
    await waitFor(a.registered);

    // baseline: no flag, auto off → text
    a.client.sendReply({ room: "-100", text: "before" });
    await waitFor(() => adapter.sent.some((s) => s.out.text === "before"));
    expect(adapter.sentVoices).toHaveLength(0);

    // admin flips auto on at runtime (user1 is the allowlist seed → admin)
    await adapter.deliver({
      adapter: "loopback",
      room: "-100",
      fromKind: "human",
      fromId: "user1",
      text: "/set ttsauto on",
      mentions: [],
    });
    await waitFor(() => adapter.sent.some((s) => s.out.text.includes("ttsauto = on")));

    // now the same no-flag reply is voiced
    a.client.sendReply({ room: "-100", text: "after, all green" });
    await waitFor(() => adapter.sentVoices.length >= 1);
  });

  it("@operator sets a Telegram mention of the admins and isn't routed as a peer (#94)", async () => {
    const { adapter, url } = await startHub(); // loopback, HUB_ALLOWLIST=user1 → admins=[user1]
    const a = attach(url, "platform");
    await waitFor(a.registered);

    a.client.sendReply({ room: "-100", text: "blocked, need your call", mentions: ["operator"] });
    await waitFor(() => adapter.sent.length >= 1);
    expect(adapter.sent[0].out.mentionUserIds).toEqual(["user1"]); // operator = admins
    await delay(20);
    // exactly the visible copy — "operator" is not a peer, so no re-inject / offline notice
    expect(adapter.sent).toHaveLength(1);
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
