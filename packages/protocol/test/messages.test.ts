import { describe, it, expect } from "vitest";
import {
  inboundMessageSchema,
  isBroadcastMention,
  isOperatorMention,
  outboundMessageSchema,
  routeTargetSchema,
} from "../src/index.js";

describe("isBroadcastMention", () => {
  it("recognizes the reserved broadcast aliases, case-insensitively", () => {
    expect(isBroadcastMention("all")).toBe(true);
    expect(isBroadcastMention("Everyone")).toBe(true);
    expect(isBroadcastMention("TEAM")).toBe(true);
    expect(isBroadcastMention("re-infra")).toBe(false);
    expect(isBroadcastMention("allies")).toBe(false);
  });
});

describe("isOperatorMention (#94)", () => {
  it("recognizes the reserved operator aliases, case-insensitively", () => {
    expect(isOperatorMention("operator")).toBe(true);
    expect(isOperatorMention("Operator")).toBe(true);
    expect(isOperatorMention("op")).toBe(true);
    expect(isOperatorMention("operators")).toBe(false);
    expect(isOperatorMention("infra")).toBe(false);
  });
});

describe("inboundMessageSchema", () => {
  it("parses a valid human message and defaults mentions to []", () => {
    const parsed = inboundMessageSchema.parse({
      adapter: "telegram",
      room: "-100123",
      fromKind: "human",
      fromId: "42",
      text: "hi @re-infra",
    });
    expect(parsed.mentions).toEqual([]);
    expect(parsed.attachments).toBeUndefined();
  });

  it("keeps provided mentions and attachments", () => {
    const parsed = inboundMessageSchema.parse({
      adapter: "telegram",
      room: "-100123",
      fromKind: "agent",
      fromId: "re-gitops",
      text: "over to you @re-infra",
      mentions: ["re-infra"],
      attachments: ["file://x"],
    });
    expect(parsed.mentions).toEqual(["re-infra"]);
    expect(parsed.attachments).toEqual(["file://x"]);
  });

  it("rejects an empty room and an invalid fromKind", () => {
    expect(() =>
      inboundMessageSchema.parse({
        adapter: "telegram",
        room: "",
        fromKind: "human",
        fromId: "42",
        text: "x",
      }),
    ).toThrow();
    expect(() =>
      inboundMessageSchema.parse({
        adapter: "telegram",
        room: "r",
        fromKind: "robot",
        fromId: "42",
        text: "x",
      }),
    ).toThrow();
  });
});

describe("outboundMessageSchema / routeTargetSchema", () => {
  it("defaults outbound kind to reply", () => {
    const parsed = outboundMessageSchema.parse({ agent: "re-infra", text: "done" });
    expect(parsed.kind).toBe("reply");
  });

  it("accepts a notice kind", () => {
    const parsed = outboundMessageSchema.parse({
      agent: "hub",
      text: "paused",
      kind: "notice",
    });
    expect(parsed.kind).toBe("notice");
  });

  it("parses a route target with an optional replyToId", () => {
    const parsed = routeTargetSchema.parse({ adapter: "telegram", room: "r" });
    expect(parsed.replyToId).toBeUndefined();
  });
});
