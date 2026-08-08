import { describe, it, expect } from "vitest";
import { speakableText, checkVoiceReply } from "../src/index.js";

describe("speakableText", () => {
  it("keeps a short plain reply", () => {
    expect(speakableText("Done — deployed to prod.", 300)).toBe("Done — deployed to prod.");
  });

  it("strips fenced and inline code", () => {
    expect(speakableText("run this:\n```\nnpm ci\n```\nthen deploy", 300)).toBe(
      "run this: then deploy",
    );
    expect(speakableText("set `DEBUG=1` first", 300)).toBe("set first");
  });

  it("drops URLs", () => {
    expect(speakableText("logs at https://example.com/x?y=1 now", 300)).toBe("logs at now");
  });

  it("returns null for nothing speakable (code/URL only)", () => {
    expect(speakableText("```\nmore code\n```", 300)).toBeNull();
    expect(speakableText("https://example.com/only", 300)).toBeNull();
  });

  it("returns null when the speakable text is too long", () => {
    expect(speakableText("word ".repeat(100), 50)).toBeNull();
  });
});

describe("checkVoiceReply (author-facing prediction, #74)", () => {
  const caps = { enabled: true, maxChars: 300 };

  it("voices a short speakable reply", () => {
    expect(checkVoiceReply("done, deployed to prod", caps)).toEqual({ voiced: true });
  });

  it("reports the char count and cap when the reply is too long", () => {
    const long = "word ".repeat(100); // 499 speakable chars > 300
    const out = checkVoiceReply(long, caps);
    expect(out.voiced).toBe(false);
    expect(out.reason).toContain("499 chars");
    expect(out.reason).toContain("300-char cap");
  });

  it("agrees with speakableText on the length boundary", () => {
    // if the hub would voice it (speakableText non-null), the channel predicts voiced
    const text = "a".repeat(300);
    expect(speakableText(text, 300)).not.toBeNull();
    expect(checkVoiceReply(text, caps).voiced).toBe(true);
    const over = "a".repeat(301);
    expect(speakableText(over, 300)).toBeNull();
    expect(checkVoiceReply(over, caps).voiced).toBe(false);
  });

  it("explains an all-code/links reply that has nothing to speak", () => {
    const out = checkVoiceReply("```\nnpm ci\n```", caps);
    expect(out.voiced).toBe(false);
    expect(out.reason).toContain("nothing speakable");
  });

  it("reports voice unavailable when the hub has no TTS", () => {
    expect(checkVoiceReply("all green", { enabled: false, maxChars: 300 }).voiced).toBe(false);
    expect(checkVoiceReply("all green", undefined).voiced).toBe(false);
  });
});
