import { describe, it, expect } from "vitest";
import { ReplyIndex } from "../src/adapters/telegram/reply-index.js";

describe("ReplyIndex", () => {
  it("resolves a recorded message back to its agent", () => {
    const idx = new ReplyIndex();
    idx.record("-100", 7, "re-infra");
    expect(idx.resolve("-100", 7)).toBe("re-infra");
  });

  it("keys by room, so the same message_id in another chat doesn't collide", () => {
    const idx = new ReplyIndex();
    idx.record("-100", 7, "re-infra");
    idx.record("555", 7, "re-gitops");
    expect(idx.resolve("-100", 7)).toBe("re-infra");
    expect(idx.resolve("555", 7)).toBe("re-gitops");
  });

  it("returns undefined for an unknown message", () => {
    expect(new ReplyIndex().resolve("-100", 1)).toBeUndefined();
  });

  it("expires entries older than the TTL", () => {
    let t = 0;
    const idx = new ReplyIndex({ ttlMs: 1000, now: () => t });
    idx.record("-100", 7, "re-infra");
    t = 1000;
    expect(idx.resolve("-100", 7)).toBe("re-infra"); // exactly at the edge still valid
    t = 1001;
    expect(idx.resolve("-100", 7)).toBeUndefined();
  });

  it("evicts the oldest entries past maxEntries", () => {
    const idx = new ReplyIndex({ maxEntries: 2 });
    idx.record("r", 1, "a");
    idx.record("r", 2, "b");
    idx.record("r", 3, "c"); // evicts message 1
    expect(idx.resolve("r", 1)).toBeUndefined();
    expect(idx.resolve("r", 2)).toBe("b");
    expect(idx.resolve("r", 3)).toBe("c");
  });

  it("re-recording refreshes recency so it isn't the next evicted", () => {
    const idx = new ReplyIndex({ maxEntries: 2 });
    idx.record("r", 1, "a");
    idx.record("r", 2, "b");
    idx.record("r", 1, "a"); // 1 is now most-recent
    idx.record("r", 3, "c"); // evicts 2, not 1
    expect(idx.resolve("r", 1)).toBe("a");
    expect(idx.resolve("r", 2)).toBeUndefined();
    expect(idx.resolve("r", 3)).toBe("c");
  });
});
