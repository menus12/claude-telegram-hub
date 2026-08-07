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
    expect(cfg.presence).toBe(false);
    expect(cfg.presenceGraceMs).toBe(10000);
    expect(cfg.tagSigil).toBe("@");
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.bindPort).toBe(8787);
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

  it("coerces the presence grace window", () => {
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE_GRACE_MS: "0" }).presenceGraceMs).toBe(0);
    expect(loadHubConfig({ ...minimal, HUB_PRESENCE_GRACE_MS: "5000" }).presenceGraceMs).toBe(
      5000,
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
