import { describe, it, expect } from "vitest";
import {
  sessionToHubFrameSchema,
  hubToSessionFrameSchema,
  wireFrameSchema,
  registerFrameSchema,
  errorFrameSchema,
  PROTOCOL_VERSION,
} from "../src/index.js";

describe("session→hub frames", () => {
  it("parses a register frame", () => {
    const frame = sessionToHubFrameSchema.parse({
      type: "register",
      protocolVersion: PROTOCOL_VERSION,
      agent: "re-infra",
      secret: "s3cr3t",
    });
    expect(frame.type).toBe("register");
  });

  it("defaults reply mentions to []", () => {
    const frame = sessionToHubFrameSchema.parse({
      type: "reply",
      room: "-100",
      text: "ok",
    });
    if (frame.type !== "reply") throw new Error("expected reply");
    expect(frame.mentions).toEqual([]);
  });

  it("rejects a register frame missing its secret", () => {
    expect(() =>
      registerFrameSchema.parse({
        type: "register",
        protocolVersion: PROTOCOL_VERSION,
        agent: "re-infra",
      }),
    ).toThrow();
  });

  it("rejects an unknown frame type", () => {
    expect(() =>
      sessionToHubFrameSchema.parse({ type: "nope" }),
    ).toThrow();
  });
});

describe("hub→session frames", () => {
  it("parses an inbound frame with a coordination thread", () => {
    const frame = hubToSessionFrameSchema.parse({
      type: "inbound",
      coordinationThread: "t-1",
      message: {
        adapter: "telegram",
        room: "-100",
        fromKind: "agent",
        fromId: "re-gitops",
        text: "ping @re-infra",
        mentions: ["re-infra"],
      },
    });
    if (frame.type !== "inbound") throw new Error("expected inbound");
    expect(frame.coordinationThread).toBe("t-1");
    expect(frame.message.mentions).toEqual(["re-infra"]);
  });

  it("defaults error.fatal to false and validates the code enum", () => {
    const frame = errorFrameSchema.parse({
      type: "error",
      code: "auth_failed",
      message: "bad secret",
    });
    expect(frame.fatal).toBe(false);
    expect(() =>
      errorFrameSchema.parse({ type: "error", code: "kaboom", message: "x" }),
    ).toThrow();
  });
});

describe("wireFrameSchema", () => {
  it("accepts frames from either direction", () => {
    expect(
      wireFrameSchema.parse({ type: "heartbeat" }).type,
    ).toBe("heartbeat");
    expect(
      wireFrameSchema.parse({
        type: "registered",
        agent: "re-infra",
        protocolVersion: PROTOCOL_VERSION,
      }).type,
    ).toBe("registered");
  });
});
