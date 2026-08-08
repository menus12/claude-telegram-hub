import { describe, it, expect } from "vitest";
import { speakableText } from "../src/index.js";

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
