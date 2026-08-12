import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadChannelConfig, loadChannelConfigs } from "../src/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cth-channel-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRepoFile(obj: unknown): void {
  writeFileSync(join(dir, ".telegram-hub.json"), JSON.stringify(obj));
}

describe("loadChannelConfig", () => {
  it("resolves with env at highest precedence, repo file next", () => {
    writeRepoFile({
      hubUrl: "ws://file:8787",
      sessionSecret: "file-secret",
      agent: "file-agent",
    });
    // HOME points at the isolated temp dir so no real ~/.config is read.
    const cfg = loadChannelConfig({
      env: { TELEGRAM_HUB_URL: "ws://env:8787", HOME: dir },
      cwd: dir,
    });
    expect(cfg.hubUrl).toBe("ws://env:8787"); // env wins
    expect(cfg.sessionSecret).toBe("file-secret"); // from repo file
    expect(cfg.agent).toBe("file-agent"); // from repo file
  });

  it("falls back to the cwd basename for the agent name", () => {
    writeRepoFile({ hubUrl: "ws://h:8787", sessionSecret: "s" });
    const cfg = loadChannelConfig({ env: { HOME: dir }, cwd: dir });
    expect(cfg.agent).toBe(basename(dir));
  });

  it("treats an absent repo file as an empty layer", () => {
    const cfg = loadChannelConfig({
      env: {
        HOME: dir,
        TELEGRAM_HUB_URL: "ws://h:8787",
        TELEGRAM_HUB_SECRET: "s",
        TELEGRAM_HUB_AGENT: "a",
      },
      cwd: dir,
    });
    expect(cfg.agent).toBe("a");
    expect(cfg.hubUrl).toBe("ws://h:8787");
  });

  it("throws clearly on malformed JSON in the repo file", () => {
    writeFileSync(join(dir, ".telegram-hub.json"), "{ not valid json");
    expect(() => loadChannelConfig({ env: { HOME: dir }, cwd: dir })).toThrow(
      /Invalid JSON/,
    );
  });

  it("throws clearly when a required value is missing", () => {
    expect(() =>
      loadChannelConfig({ env: { HOME: dir, TELEGRAM_HUB_SECRET: "s" }, cwd: dir }),
    ).toThrow(/hubUrl/);
  });

  it("applies reconnect defaults when unset", () => {
    writeRepoFile({ hubUrl: "ws://h:8787", sessionSecret: "s", agent: "a" });
    const cfg = loadChannelConfig({ env: { HOME: dir }, cwd: dir });
    expect(cfg.reconnectInitialMs).toBe(500);
    expect(cfg.reconnectMaxMs).toBe(15000);
    expect(cfg.logLevel).toBe("info");
  });
});

describe("loadChannelConfigs (multi-hub, #90)", () => {
  it("wraps a single-hub config as a 1-element list (label = agent)", () => {
    writeRepoFile({ hubUrl: "ws://h:8787", sessionSecret: "s", agent: "kb" });
    const hubs = loadChannelConfigs({ env: { HOME: dir }, cwd: dir });
    expect(hubs).toHaveLength(1);
    expect(hubs[0]).toMatchObject({ label: "kb", hubUrl: "ws://h:8787", agent: "kb" });
  });

  it("resolves a `hubs` array into N labeled connections, sharing top-level fields", () => {
    writeRepoFile({
      logLevel: "warn",
      hubs: [
        { label: "learn", hubUrl: "ws://learn:8787", sessionSecret: "s1", agent: "hub" },
        { label: "cheburnet", hubUrl: "ws://cheb:8787", sessionSecret: "s2", agent: "hub" },
      ],
    });
    const hubs = loadChannelConfigs({ env: { HOME: dir }, cwd: dir });
    expect(hubs.map((h) => h.label)).toEqual(["learn", "cheburnet"]);
    expect(hubs[0]).toMatchObject({ hubUrl: "ws://learn:8787", sessionSecret: "s1", agent: "hub" });
    expect(hubs[1].hubUrl).toBe("ws://cheb:8787");
    expect(hubs[0].logLevel).toBe("warn"); // shared top-level field applied to each
    expect(hubs[0].reconnectInitialMs).toBe(500); // defaults still apply
  });

  it("rejects duplicate labels and invalid entries", () => {
    writeRepoFile({
      hubs: [
        { label: "x", hubUrl: "ws://a:8787", sessionSecret: "s", agent: "hub" },
        { label: "x", hubUrl: "ws://b:8787", sessionSecret: "s", agent: "hub" },
      ],
    });
    expect(() => loadChannelConfigs({ env: { HOME: dir }, cwd: dir })).toThrow(/duplicate hub label/);

    writeRepoFile({ hubs: [{ label: "y", hubUrl: "not-a-url", sessionSecret: "s", agent: "hub" }] });
    expect(() => loadChannelConfigs({ env: { HOME: dir }, cwd: dir })).toThrow(/hubs\[0\]/);
  });
});
