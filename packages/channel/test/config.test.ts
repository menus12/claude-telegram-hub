import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadChannelConfig } from "../src/index.js";

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
