import { describe, it, expect } from "vitest";
import {
  CLOUD_INSTRUCTIONS,
  INSTRUCTIONS_MAX_CHARS,
  RateLimiter,
  TokenStore,
  cloudAgentName,
  loadBridgeConfig,
  parseTokens,
  sha256Hex,
} from "../src/index.js";

describe("cloud instructions", () => {
  it("fit Claude Code's 4096-char MCP instructions limit", () => {
    expect(CLOUD_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });

  it("carry the receive loop, the doctrine and the precedence rule", () => {
    expect(CLOUD_INSTRUCTIONS).toContain("Keep exactly ONE `wait` pending");
    expect(CLOUD_INSTRUCTIONS).toContain("SIGNALING BUS");
    expect(CLOUD_INSTRUCTIONS).toContain("PRECEDENCE");
  });
});

describe("cloudAgentName", () => {
  it("prefixes and slugs the requested name", () => {
    expect(cloudAgentName("cloud-", "Cheburnet_Router")).toBe("cloud-cheburnet-router");
    expect(cloudAgentName("cloud-", "nsalab-tmn/cheburnet-testbed")).toBe("cloud-nsalab-tmn-cheburnet-testbed");
  });

  it("doesn't double a prefix the agent typed, and never yields a bare prefix", () => {
    expect(cloudAgentName("cloud-", "cloud-router")).toBe("cloud-router");
    expect(cloudAgentName("cloud-", "!!!")).toBe("cloud-agent");
  });

  it("caps the slug length", () => {
    expect(cloudAgentName("cloud-", "x".repeat(100))).toBe(`cloud-${"x".repeat(40)}`);
  });
});

describe("tokens", () => {
  const token = "a".repeat(64);
  const file = `# env tokens\ntestbed ${sha256Hex(token)}\n\nrouter ${sha256Hex("other-token")}\n`;

  it("verifies a bearer against the stored hashes and returns its label", () => {
    const store = new TokenStore(parseTokens(file));
    expect(store.verify(`Bearer ${token}`)).toBe("testbed");
    expect(store.verify("Bearer other-token")).toBe("router");
    expect(store.verify(`Bearer ${token}x`)).toBeUndefined();
    expect(store.verify(token)).toBeUndefined();
    expect(store.verify(undefined)).toBeUndefined();
  });

  it("rejects malformed, duplicate and empty files", () => {
    expect(() => parseTokens("testbed not-a-hash")).toThrow(/line 1/);
    expect(() => parseTokens(`a ${sha256Hex("x")}\na ${sha256Hex("y")}`)).toThrow(/duplicate/);
    expect(() => parseTokens("# nothing\n")).toThrow(/no entries/);
  });
});

describe("RateLimiter", () => {
  it("allows a burst of perMin, then refills over time", () => {
    let t = 0;
    const rl = new RateLimiter(3, () => t);
    expect([rl.take("k"), rl.take("k"), rl.take("k"), rl.take("k")]).toEqual([true, true, true, false]);
    expect(rl.take("other")).toBe(true);
    t += 20_000; // one token per 20 s at 3/min
    expect(rl.take("k")).toBe(true);
    expect(rl.take("k")).toBe(false);
  });
});

describe("loadBridgeConfig", () => {
  const base = {
    BRIDGE_HUB_URL: "ws://127.0.0.1:8787",
    BRIDGE_HUB_SECRET: "s",
    BRIDGE_TOKENS_FILE: "/etc/bridge/tokens",
    BRIDGE_DEFAULT_ROOM: "-100",
  };

  it("applies defaults", () => {
    expect(loadBridgeConfig(base)).toMatchObject({
      bindHost: "127.0.0.1",
      bindPort: 8788,
      agentPrefix: "cloud-",
      waitMaxS: 840,
      ttlMs: 900_000,
    });
  });

  it("names the env var in errors", () => {
    expect(() => loadBridgeConfig({ ...base, BRIDGE_WAIT_MAX_S: "soon" })).toThrow(/BRIDGE_WAIT_MAX_S/);
    expect(() => loadBridgeConfig({ ...base, BRIDGE_HUB_SECRET: undefined })).toThrow(/BRIDGE_HUB_SECRET/);
  });
});
