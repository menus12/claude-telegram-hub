import { describe, it, expect } from "vitest";
import { LoopGovernor } from "../src/index.js";

describe("LoopGovernor", () => {
  it("permits exactly `budget` hops, then freezes", () => {
    const g = new LoopGovernor(3);
    g.refill("r");
    expect(g.onAgentHop("r")).toEqual({ allowed: true, froze: false }); // 3->2
    expect(g.onAgentHop("r")).toEqual({ allowed: true, froze: false }); // 2->1
    expect(g.onAgentHop("r")).toEqual({ allowed: true, froze: true }); // 1->0, freeze
    expect(g.isFrozen("r")).toBe(true);
    expect(g.onAgentHop("r")).toEqual({ allowed: false, froze: false }); // blocked
  });

  it("refill resumes a frozen thread at full budget", () => {
    const g = new LoopGovernor(2);
    g.refill("r");
    g.onAgentHop("r"); // 2->1
    g.onAgentHop("r"); // 1->0 freeze
    expect(g.isFrozen("r")).toBe(true);
    g.refill("r"); // human resumes
    expect(g.isFrozen("r")).toBe(false);
    expect(g.budget("r")).toBe(2);
    expect(g.onAgentHop("r")).toEqual({ allowed: true, froze: false });
  });

  it("tracks rooms independently", () => {
    const g = new LoopGovernor(1);
    g.refill("a");
    g.refill("b");
    expect(g.onAgentHop("a")).toEqual({ allowed: true, froze: true });
    expect(g.isFrozen("a")).toBe(true);
    expect(g.isFrozen("b")).toBe(false);
    expect(g.onAgentHop("b")).toEqual({ allowed: true, froze: true });
  });

  it("self-initializes a thread if an agent hop arrives with none open", () => {
    const g = new LoopGovernor(2);
    expect(g.budget("r")).toBe(2); // full when unseen
    expect(g.onAgentHop("r")).toEqual({ allowed: true, froze: false }); // 2->1
  });

  it("reconfigure changes the budget applied on the next refill (#80)", () => {
    const g = new LoopGovernor(3);
    g.reconfigure(1);
    g.refill("r"); // now opens at budget 1
    expect(g.onAgentHop("r")).toEqual({ allowed: true, froze: true }); // 1->0 freeze
  });
});
