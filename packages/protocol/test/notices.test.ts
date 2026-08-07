import { describe, it, expect } from "vitest";
import {
  attributionPrefix,
  renderOutbound,
  offlineTargetNotice,
  loopFrozenNotice,
  presenceOnlineNotice,
  presenceOfflineNotice,
} from "../src/index.js";

describe("attribution", () => {
  it("prefixes replies with the speaking agent", () => {
    expect(attributionPrefix("re-infra")).toBe("re-infra ▸ ");
    expect(renderOutbound({ agent: "re-infra", text: "done", kind: "reply" })).toBe(
      "re-infra ▸ done",
    );
  });

  it("posts notices verbatim without attribution", () => {
    expect(renderOutbound({ agent: "hub", text: "paused", kind: "notice" })).toBe(
      "paused",
    );
  });
});

describe("hub notices", () => {
  it("builds an offline-target notice naming the agent", () => {
    const n = offlineTargetNotice("re-infra");
    expect(n.kind).toBe("notice");
    expect(n.text).toContain("@re-infra");
  });

  it("builds a loop-frozen notice", () => {
    expect(loopFrozenNotice().kind).toBe("notice");
  });

  it("builds presence notices naming the agent, attributed to the hub", () => {
    const on = presenceOnlineNotice("re-infra");
    expect(on).toMatchObject({ agent: "hub", kind: "notice" });
    expect(on.text).toBe("@re-infra is online.");
    const off = presenceOfflineNotice("re-infra");
    expect(off.text).toBe("@re-infra is offline.");
  });
});
