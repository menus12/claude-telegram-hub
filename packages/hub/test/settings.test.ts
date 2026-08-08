import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, TUNABLES, tunableByKey } from "../src/index.js";

const T = (key: string) => {
  const t = tunableByKey(key);
  if (!t) throw new Error(`no tunable ${key}`);
  return t;
};

describe("tunables registry", () => {
  it("parses and validates each value kind", () => {
    expect(T("ttsauto").parse("on")).toBe(true);
    expect(T("ttsauto").parse("off")).toBe(false);
    expect(() => T("ttsauto").parse("maybe")).toThrow(/on\/off/);

    expect(T("ttsmaxchars").parse("400")).toBe(400);
    expect(() => T("ttsmaxchars").parse("0")).toThrow(/positive/);
    expect(() => T("ttsmaxchars").parse("-5")).toThrow(/positive/);
    expect(() => T("ttsmaxchars").parse("abc")).toThrow(/positive/);

    expect(T("notify").parse("both")).toBe("both");
    expect(() => T("notify").parse("email")).toThrow(/dm\|rooms\|both/);

    expect(T("ttsvoicemap").parse("en:af_sky,ru:af_ru")).toEqual({ en: "af_sky", ru: "af_ru" });
    expect(() => T("ttsvoicemap").parse("nonsense")).toThrow(/key:value/);
  });

  it("formats values for display", () => {
    expect(T("broadcast").format(true)).toBe("on");
    expect(T("broadcast").format(false)).toBe("off");
    expect(T("ttsvoicemap").format({ en: "af_sky" })).toBe("en:af_sky");
    expect(T("ttsvoice").format(undefined)).toBe("(unset)");
  });

  it("only lists runtime-safe fields (no secrets/bind/urls)", () => {
    const fields = TUNABLES.map((t) => t.field);
    for (const boot of ["sessionSecret", "bindPort", "sttUrl", "ttsUrl", "adapter", "stateFile"]) {
      expect(fields).not.toContain(boot);
    }
  });
});

describe("SettingsStore", () => {
  it("stores and clears a global override", () => {
    const s = new SettingsStore();
    expect(s.getOverride("ttsAuto")).toBeUndefined();
    s.set(T("ttsauto"), true);
    expect(s.getOverride("ttsAuto")).toBe(true);
    expect(s.unset(T("ttsauto"))).toBe(true);
    expect(s.getOverride("ttsAuto")).toBeUndefined();
    expect(s.unset(T("ttsauto"))).toBe(false); // nothing to clear
  });

  it("persists overrides and reloads them, coexisting with other state-file keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "cth-settings-"));
    try {
      const file = join(dir, "state.json");
      // a pre-existing access section must survive a settings write
      writeFileSync(file, JSON.stringify({ allow: ["7"] }));

      const s = new SettingsStore({ stateFile: file });
      s.set(T("ttsmaxchars"), 400);
      const onDisk = JSON.parse(readFileSync(file, "utf8"));
      expect(onDisk.allow).toEqual(["7"]); // preserved
      expect(onDisk.settings.global.ttsmaxchars).toBe(400);

      const reloaded = new SettingsStore({ stateFile: file });
      expect(reloaded.getOverride("ttsMaxChars")).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
