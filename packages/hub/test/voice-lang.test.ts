import { describe, it, expect } from "vitest";
import { detectLang, pickVoice } from "../src/index.js";

describe("detectLang", () => {
  it("detects Russian by Cyrillic script", () => {
    expect(detectLang("готово, задеплоил в прод")).toBe("ru");
  });

  it("detects English by Latin script", () => {
    expect(detectLang("done, deployed to prod")).toBe("en");
  });

  it("goes with the dominant script in a mixed reply", () => {
    expect(detectLang("готово: deployed сервис в прод, всё зелёно")).toBe("ru");
    expect(detectLang("deployed the сервис to prod, all green")).toBe("en");
  });

  it("defaults to en for script-less text", () => {
    expect(detectLang("12345 — 10.0.0.1")).toBe("en");
  });
});

describe("pickVoice", () => {
  const map = { en: "af_sky", ru: "af_ru" };

  it("picks the per-language voice from the map", () => {
    expect(pickVoice("all green", "af_sky", map)).toBe("af_sky");
    expect(pickVoice("всё зелёно", "af_sky", map)).toBe("af_ru");
  });

  it("falls back to the default voice for an unmapped language", () => {
    expect(pickVoice("всё зелёно", "af_sky", { en: "af_sky" })).toBe("af_sky");
  });

  it("returns the default voice when no map is configured", () => {
    expect(pickVoice("всё зелёно", "af_sky", undefined)).toBe("af_sky");
  });
});
