import { describe, it, expect } from "vitest";
import {
  loadHubConfig,
  loadTelegramAdapterConfig,
  resolveChannelConfig,
  channelEnvLayer,
} from "../src/index.js";

describe("loadHubConfig", () => {
  const minimal = { HUB_SESSION_SECRET: "s", HUB_ALLOWLIST: "1,2" };

  it("applies defaults for everything optional", () => {
    const cfg = loadHubConfig(minimal);
    expect(cfg.allowlist).toEqual(["1", "2"]);
    expect(cfg.rooms).toEqual([]);
    expect(cfg.hopBudget).toBe(6);
    expect(cfg.broadcast).toBe(true);
    expect(cfg.presence).toBe(false);
    expect(cfg.presenceGraceMs).toBe(10000);
    expect(cfg.sla).toBe(false);
    expect(cfg.ackSlaMs).toBe(120000);
    expect(cfg.answerSlaMs).toBe(600000);
    expect(cfg.duplicateName).toBe("reject");
    expect(cfg.notify).toBe("dm");
    expect(cfg.admins).toEqual([]);
    expect(cfg.operatorUsernames).toEqual([]);
    expect(cfg.stateFile).toBeUndefined();
    expect(cfg.pairing).toBe(false);
    expect(cfg.sttUrl).toBeUndefined();
    expect(cfg.sttModel).toBe("small");
    expect(cfg.sttLang).toBe("auto");
    expect(cfg.voiceEcho).toBe(true);
    expect(cfg.ttsUrl).toBeUndefined();
    expect(cfg.ttsFormat).toBe("opus");
    expect(cfg.ttsMaxChars).toBe(300);
    expect(cfg.ttsAuto).toBe("off");
    expect(cfg.sttApiKey).toBeUndefined();
    expect(cfg.ttsApiKey).toBeUndefined();
    expect(cfg.sttAuthHeader).toBeUndefined();
    expect(cfg.tagSigil).toBe("@");
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.bindPort).toBe(8787);
    expect(cfg.keepaliveMs).toBe(30000);
    expect(cfg.adapter).toBe("telegram");
    expect(cfg.logLevel).toBe("info");
  });

  it("coerces HUB_PRESENCE from on/off-style tokens", () => {
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE: "on" }).presence).toBe(true);
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE: "true" }).presence).toBe(true);
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE: "1" }).presence).toBe(true);
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE: "OFF" }).presence).toBe(false);
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE: "no" }).presence).toBe(false);
  });

  it("rejects an unrecognized HUB_PRESENCE value", () => {
    expect(() => loadHubConfig({ ...minimal, HUB_PRESENCE: "maybe" })).toThrow(/presence/);
  });

  it("parses HUB_OPERATOR_USERNAMES, stripping a leading @ (#94)", () => {
    expect(
      loadHubConfig({ ...minimal, HUB_OPERATOR_USERNAMES: "@a_gorbachev, bob" }).operatorUsernames,
    ).toEqual(["a_gorbachev", "bob"]);
    expect(
      loadHubConfig({ ...minimal, HUB_OPERATOR_USERNAMES: "a_gorbachev" }).operatorUsernames,
    ).toEqual(["a_gorbachev"]);
  });

  it("coerces the presence grace window", () => {
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE_GRACE_MS: "0" }).presenceGraceMs).toBe(0);
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE_GRACE_MS: "5000" }).presenceGraceMs).toBe(
      5000,
    );
  });

  it("reads the response-SLA toggle and windows", () => {
    const cfg = loadHubConfig({
      ...minimal,
      HUB_SLA: "on",
      HUB_ACK_SLA: "60000",
      HUB_ANSWER_SLA: "300000",
    });
    expect(cfg.sla).toBe(true);
    expect(cfg.ackSlaMs).toBe(60000);
    expect(cfg.answerSlaMs).toBe(300000);
  });

  it("rejects an answer window that isn't greater than the ack window", () => {
    expect(() =>
      loadHubConfig({ ...minimal, HUB_ACK_SLA: "300000", HUB_ANSWER_SLA: "120000" }),
    ).toThrow(/answerSlaMs/);
  });

  it("reads the STT knobs and validates the URL", () => {
    const cfg = loadHubConfig({
      ...minimal,
      HUB_STT_URL: "http://stt:8000",
      HUB_STT_MODEL: "medium",
      HUB_STT_LANG: "ru",
    });
    expect(cfg.sttUrl).toBe("http://stt:8000");
    expect(cfg.sttModel).toBe("medium");
    expect(cfg.sttLang).toBe("ru");
    const cloud = loadHubConfig({
      ...minimal,
      HUB_STT_URL: "https://api.openai.com",
      HUB_STT_API_KEY: "sk-abc",
      HUB_STT_AUTH_HEADER: "api-key",
    });
    expect(cloud.sttApiKey).toBe("sk-abc");
    expect(cloud.sttAuthHeader).toBe("api-key");
    expect(() => loadHubConfig({ ...minimal, HUB_STT_URL: "not-a-url" })).toThrow(/sttUrl/);
  });

  it("reads the admin/state/pairing knobs", () => {
    const cfg = loadHubConfig({
      ...minimal,
      HUB_ADMINS: "1, 2",
      HUB_STATE_FILE: "/data/access.json",
      HUB_PAIRING: "on",
    });
    expect(cfg.admins).toEqual(["1", "2"]);
    expect(cfg.stateFile).toBe("/data/access.json");
    expect(cfg.pairing).toBe(true);
  });

  it("reads the TTS knobs and requires model+voice when the URL is set", () => {
    const cfg = loadHubConfig({
      ...minimal,
      HUB_TTS_URL: "http://tts:8000",
      HUB_TTS_MODEL: "kokoro",
      HUB_TTS_VOICE: "af_sky",
    });
    expect(cfg.ttsUrl).toBe("http://tts:8000");
    expect(cfg.ttsModel).toBe("kokoro");
    expect(cfg.ttsVoice).toBe("af_sky");
    expect(loadHubConfig({ ...minimal, HUB_TTS_AUTO: "on" }).ttsAuto).toBe("on");
    expect(loadHubConfig({ ...minimal, HUB_TTS_AUTO: "true" }).ttsAuto).toBe("on"); // legacy
    expect(loadHubConfig({ ...minimal, HUB_TTS_AUTO: "reply-to-voice" }).ttsAuto).toBe("reply-to-voice");
    // URL set but model/voice missing → rejected
    expect(() => loadHubConfig({ ...minimal, HUB_TTS_URL: "http://tts:8000" })).toThrow(
      /ttsModel/,
    );
  });

  it("reads the notification target and rejects an unknown value", () => {
    expect(loadHubConfig({ ...minimal, HUB_NOTIFY: "both" }).notify).toBe("both");
    expect(loadHubConfig({ ...minimal, HUB_NOTIFY: "rooms" }).notify).toBe("rooms");
    expect(() => loadHubConfig({ ...minimal, HUB_NOTIFY: "email" })).toThrow(/notify/);
  });

  it("reads the duplicate-name policy and rejects an unknown value", () => {
    expect(loadHubConfig({ ...minimal, HUB_DUPLICATE_NAME: "replace" }).duplicateName).toBe(
      "replace",
    );
    expect(() => loadHubConfig({ ...minimal, HUB_DUPLICATE_NAME: "takeover" })).toThrow(
      /duplicateName/,
    );
  });

  it("parses csv lists and coerces numeric ports/budgets", () => {
    const cfg = loadHubConfig({
      ...minimal,
      HUB_ALLOWLIST: " 1 , 2 ,,3 ",
      HUB_ROOMS: "-100,-200",
      HUB_HOP_BUDGET: "10",
      HUB_BIND_PORT: "9000",
    });
    expect(cfg.allowlist).toEqual(["1", "2", "3"]);
    expect(cfg.rooms).toEqual(["-100", "-200"]);
    expect(cfg.hopBudget).toBe(10);
    expect(cfg.bindPort).toBe(9000);
  });

  it("throws with a clear message when a required secret is missing", () => {
    expect(() => loadHubConfig({ HUB_ALLOWLIST: "1" })).toThrow(/sessionSecret/);
  });

  it("throws when the allowlist is empty", () => {
    expect(() => loadHubConfig({ HUB_SESSION_SECRET: "s", HUB_ALLOWLIST: "" })).toThrow(
      /allowlist/,
    );
  });

  it("rejects a non-numeric port", () => {
    expect(() =>
      loadHubConfig({ ...minimal, HUB_BIND_PORT: "abc" }),
    ).toThrow(/bindPort/);
  });
});

describe("loadTelegramAdapterConfig", () => {
  it("reads the bot token", () => {
    expect(loadTelegramAdapterConfig({ TELEGRAM_BOT_TOKEN: "t" }).botToken).toBe("t");
  });
  it("throws when the token is absent", () => {
    expect(() => loadTelegramAdapterConfig({})).toThrow(/botToken/);
  });
});

describe("resolveChannelConfig", () => {
  it("applies earlier-layer-wins precedence and the agent fallback", () => {
    const cfg = resolveChannelConfig(
      [
        { hubUrl: "ws://env:8787" }, // env (highest)
        { hubUrl: "ws://file:8787", sessionSecret: "s", agent: "from-file" },
      ],
      { agentFallback: "cwd-basename" },
    );
    expect(cfg.hubUrl).toBe("ws://env:8787");
    expect(cfg.sessionSecret).toBe("s");
    expect(cfg.agent).toBe("from-file");
    expect(cfg.reconnectInitialMs).toBe(500);
    expect(cfg.maxFileMb).toBe(50);
  });

  it("coerces the max file size from env", () => {
    const cfg = resolveChannelConfig([
      channelEnvLayer({
        TELEGRAM_HUB_URL: "ws://h:8787",
        TELEGRAM_HUB_SECRET: "s",
        TELEGRAM_HUB_AGENT: "a",
        TELEGRAM_HUB_MAX_FILE_MB: "20",
      }),
    ]);
    expect(cfg.maxFileMb).toBe(20);
  });

  it("uses the agent fallback when no layer supplies one", () => {
    const cfg = resolveChannelConfig(
      [{ hubUrl: "ws://h:8787", sessionSecret: "s" }],
      { agentFallback: "my-repo" },
    );
    expect(cfg.agent).toBe("my-repo");
  });

  it("treats blank layer values as absent", () => {
    const cfg = resolveChannelConfig([
      { hubUrl: "", sessionSecret: "" },
      { hubUrl: "ws://h:8787", sessionSecret: "s", agent: "a" },
    ]);
    expect(cfg.hubUrl).toBe("ws://h:8787");
  });

  it("builds a layer from env and rejects a missing hub url", () => {
    const layer = channelEnvLayer({
      TELEGRAM_HUB_SECRET: "s",
      TELEGRAM_HUB_AGENT: "a",
    });
    expect(() => resolveChannelConfig([layer])).toThrow(/hubUrl/);
  });

  it("rejects a malformed hub url", () => {
    expect(() =>
      resolveChannelConfig([{ hubUrl: "not a url", sessionSecret: "s", agent: "a" }]),
    ).toThrow(/hubUrl/);
  });
});
