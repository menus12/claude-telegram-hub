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

  it("parses a send_file frame with an optional caption", () => {
    const frame = sessionToHubFrameSchema.parse({
      type: "send_file",
      room: "-100",
      file: { filename: "a.png", mimeType: "image/png", dataBase64: "AAAA" },
      caption: "here",
    });
    if (frame.type !== "send_file") throw new Error("expected send_file");
    expect(frame.file.filename).toBe("a.png");
    expect(frame.caption).toBe("here");
    expect(frame.mentions).toEqual([]); // defaults to no agent recipients
  });

  it("parses a send_file frame with peer mentions (agent→agent handoff)", () => {
    const frame = sessionToHubFrameSchema.parse({
      type: "send_file",
      room: "-100",
      file: { filename: "a.png", mimeType: "image/png", dataBase64: "AAAA" },
      mentions: ["kb", "core"],
    });
    if (frame.type !== "send_file") throw new Error("expected send_file");
    expect(frame.mentions).toEqual(["kb", "core"]);
  });

  it("rejects a send_file frame with an empty file payload", () => {
    expect(() =>
      sessionToHubFrameSchema.parse({
        type: "send_file",
        room: "-100",
        file: { filename: "", mimeType: "image/png", dataBase64: "AAAA" },
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
    expect(frame.file).toBeUndefined();
  });

  it("parses an inbound frame carrying a file payload", () => {
    const frame = hubToSessionFrameSchema.parse({
      type: "inbound",
      message: {
        adapter: "telegram",
        room: "-100",
        fromKind: "human",
        fromId: "42",
        text: "@re-infra see this",
        mentions: ["re-infra"],
        attachments: ["shot.png"],
      },
      file: { filename: "shot.png", mimeType: "image/png", dataBase64: "AAAA" },
    });
    if (frame.type !== "inbound") throw new Error("expected inbound");
    expect(frame.file?.filename).toBe("shot.png");
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
