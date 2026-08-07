import { describe, it, expect } from "vitest";
import { resolveSpokenRecipients } from "../src/index.js";

const roster = ["platform", "re-infra", "re-gitops"];

describe("resolveSpokenRecipients", () => {
  it("resolves a single leading name (unicast)", () => {
    expect(resolveSpokenRecipients("platform, redeploy the service", roster)).toEqual({
      recipients: ["platform"],
      broadcast: false,
    });
  });

  it("matches an awkward repo-basename via a natural spoken word", () => {
    // "infra" → re-infra, "git ops" → re-gitops
    expect(resolveSpokenRecipients("infra bump the log level", roster).recipients).toEqual([
      "re-infra",
    ]);
    expect(resolveSpokenRecipients("gitops roll it back", roster).recipients).toEqual([
      "re-gitops",
    ]);
  });

  it("resolves several names joined by a connector (multicast)", () => {
    expect(resolveSpokenRecipients("platform and gitops sync up", roster).recipients).toEqual([
      "platform",
      "re-gitops",
    ]);
  });

  it("treats a mid-sentence name as content, not a recipient", () => {
    // addresses platform only; "gitops" here is part of the message
    expect(resolveSpokenRecipients("platform, ask gitops about the egress IP", roster)).toEqual({
      recipients: ["platform"],
      broadcast: false,
    });
  });

  it("flags a leading broadcast keyword (EN and RU)", () => {
    expect(resolveSpokenRecipients("everyone stand down", roster).broadcast).toBe(true);
    expect(resolveSpokenRecipients("всем внимание", roster).broadcast).toBe(true);
  });

  it("returns nothing when the opening isn't an address", () => {
    expect(resolveSpokenRecipients("can you redeploy the service", roster)).toEqual({
      recipients: [],
      broadcast: false,
    });
  });

  it("does not match too-short leading tokens", () => {
    // "re" alone (len 2) must not match re-infra/re-gitops
    expect(resolveSpokenRecipients("re do the thing", roster).recipients).toEqual([]);
  });
});
