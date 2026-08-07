import { describe, it, expect } from "vitest";
import {
  attributionPrefix,
  parseAttribution,
  renderOutbound,
  offlineTargetNotice,
  loopFrozenNotice,
  presenceOnlineNotice,
  presenceOfflineNotice,
  slaEscalationNotice,
  duplicateRegistrationNotice,
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

  it("recovers the agent from an attributed message and ignores unattributed text", () => {
    expect(parseAttribution("re-infra ▸ deployed to prod")).toBe("re-infra");
    // round-trips with the prefix builder
    expect(parseAttribution(`${attributionPrefix("re_gitops")}done`)).toBe("re_gitops");
    // not attributed → undefined (notices, plain human text)
    expect(parseAttribution("@re-infra is online.")).toBeUndefined();
    expect(parseAttribution("just some text")).toBeUndefined();
    expect(parseAttribution(" ▸ leading separator")).toBeUndefined();
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

  it("builds an SLA escalation notice naming both agents and the window", () => {
    const n = slaEscalationNotice("re-infra", "re-gitops", 10);
    expect(n).toMatchObject({ agent: "hub", kind: "notice" });
    expect(n.text).toContain("@re-infra");
    expect(n.text).toContain("@re-gitops");
    expect(n.text).toContain("10 min");
  });

  it("builds a duplicate-registration notice naming the agent", () => {
    const n = duplicateRegistrationNotice("re-infra");
    expect(n).toMatchObject({ agent: "hub", kind: "notice" });
    expect(n.text).toContain("@re-infra");
  });
});
