import { describe, it, expect } from "vitest";
import { VoiceParking, isBareMentions } from "../src/voice-parking.js";

describe("VoiceParking (#109)", () => {
  it("hands a parked transcript to the same sender in the same room, once", () => {
    const p = new VoiceParking(1000, () => 0);
    p.park("r", "u1", "redeploy the service");
    expect(p.claim("r", "u2")).toBeUndefined();
    expect(p.claim("other", "u1")).toBeUndefined();
    expect(p.claim("r", "u1")?.text).toBe("redeploy the service");
    expect(p.claim("r", "u1")).toBeUndefined();
  });

  it("expires a transcript after the window", () => {
    let t = 0;
    const p = new VoiceParking(1000, () => t);
    p.park("r", "u1", "late");
    t = 1001;
    expect(p.claim("r", "u1")).toBeUndefined();
  });

  it("keeps only the newest note per sender", () => {
    const p = new VoiceParking(1000, () => 0);
    p.park("r", "u1", "first");
    p.park("r", "u1", "second");
    expect(p.claim("r", "u1")?.text).toBe("second");
  });
});

describe("isBareMentions (#109)", () => {
  it("accepts tags with whitespace and punctuation only", () => {
    expect(isBareMentions("@kb", "@")).toBe(true);
    expect(isBareMentions("  @kb, @infra ", "@")).toBe(true);
  });

  it("rejects a message with its own words, or no tag at all", () => {
    expect(isBareMentions("@kb look at this", "@")).toBe(false);
    expect(isBareMentions("ok", "@")).toBe(false);
    expect(isBareMentions("", "@")).toBe(false);
  });
});
