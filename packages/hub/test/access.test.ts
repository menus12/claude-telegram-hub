import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessController, parseCommand } from "../src/index.js";

describe("parseCommand", () => {
  it("parses a bare command and one with args", () => {
    expect(parseCommand("/pending")).toEqual({ name: "pending", args: [] });
    expect(parseCommand("/allow 12345")).toEqual({ name: "allow", args: ["12345"] });
  });

  it("strips a @botname suffix and lowercases the name", () => {
    expect(parseCommand("/Allow@my_bot 9")).toEqual({ name: "allow", args: ["9"] });
  });

  it("returns null for non-command text", () => {
    expect(parseCommand("hello @re-infra")).toBeNull();
    expect(parseCommand("  not/a/command")).toBeNull();
  });
});

describe("AccessController", () => {
  const make = (over: Partial<ConstructorParameters<typeof AccessController>[0]> = {}) =>
    new AccessController({ seed: ["1"], admins: ["1"], ...over });

  it("allows seed ids and admins, and reports admin status", () => {
    const a = make();
    expect(a.isAllowed("1")).toBe(true);
    expect(a.isAllowed("2")).toBe(false);
    expect(a.isAdmin("1")).toBe(true);
    expect(a.isAdmin("2")).toBe(false);
  });

  it("grants and revokes at runtime; deny overrides the seed", () => {
    const a = make();
    a.allowUser("2");
    expect(a.isAllowed("2")).toBe(true);
    a.denyUser("2");
    expect(a.isAllowed("2")).toBe(false);
    a.denyUser("1"); // deny a seed id
    expect(a.isAllowed("1")).toBe(false);
  });

  it("queues pending ids (once) and lists allowed/pending", () => {
    const a = make();
    expect(a.addPending("2")).toBe(true);
    expect(a.addPending("2")).toBe(false); // already pending
    expect(a.addPending("1")).toBe(false); // already allowed
    expect(a.listPending()).toEqual(["2"]);
    a.allowUser("2"); // approving clears pending
    expect(a.listPending()).toEqual([]);
    expect(a.listAllowed()).toEqual(["1", "2"]);
  });

  it("persists runtime changes and reloads them (survives a restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cth-access-"));
    try {
      const file = join(dir, "state.json");
      const a = make({ stateFile: file });
      a.allowUser("2");
      a.addPending("3");
      expect(JSON.parse(readFileSync(file, "utf8")).allow).toContain("2");

      // a fresh controller (a "restart") loads the persisted state and re-applies the seed
      const b = new AccessController({ seed: ["1"], admins: ["1"], stateFile: file });
      expect(b.isAllowed("2")).toBe(true);
      expect(b.isAllowed("1")).toBe(true); // seed still applies
      expect(b.listPending()).toEqual(["3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
