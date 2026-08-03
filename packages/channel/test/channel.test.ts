import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildChannel,
  buildInboundNotification,
  parseReplyArgs,
} from "../src/index.js";
import type { HubClientEvents, ReplyInput } from "../src/index.js";
import type { ChannelConfig, InboundFrame } from "@claude-telegram-hub/protocol";

function cfg(): ChannelConfig {
  return {
    hubUrl: "ws://unused:8787",
    sessionSecret: "s",
    agent: "a",
    logLevel: "error",
    reconnectInitialMs: 50,
    reconnectMaxMs: 100,
  };
}

function humanFrame(text: string, mentions: string[] = []): InboundFrame {
  return {
    type: "inbound",
    message: {
      adapter: "telegram",
      room: "-100",
      fromKind: "human",
      fromId: "42",
      text,
      mentions,
    },
  };
}

describe("buildInboundNotification", () => {
  it("passes human text through with routing meta", () => {
    const note = buildInboundNotification(humanFrame("hello"));
    expect(note.method).toBe("notifications/claude/channel");
    expect(note.params.content).toBe("hello");
    expect(note.params.meta).toMatchObject({
      room: "-100",
      from_kind: "human",
      from_id: "42",
      adapter: "telegram",
    });
    expect(note.params.meta.mentions).toBeUndefined();
  });

  it("labels agent-origin messages and carries mentions + thread", () => {
    const frame: InboundFrame = {
      type: "inbound",
      coordinationThread: "t1",
      message: {
        adapter: "telegram",
        room: "-100",
        fromKind: "agent",
        fromId: "re-gitops",
        text: "ping",
        mentions: ["re-infra"],
      },
    };
    const note = buildInboundNotification(frame);
    expect(note.params.content).toBe("From agent re-gitops: ping");
    expect(note.params.meta.mentions).toBe("re-infra");
    expect(note.params.meta.thread).toBe("t1");
  });

  it("emits only identifier-safe meta keys", () => {
    const meta = buildInboundNotification(
      humanFrame("x", ["a", "b"]),
    ).params.meta;
    for (const key of Object.keys(meta)) {
      expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });
});

describe("parseReplyArgs", () => {
  it("accepts room + text", () => {
    expect(parseReplyArgs({ room: "-100", text: "hi" })).toEqual({
      room: "-100",
      text: "hi",
      mentions: undefined,
    });
  });

  it("accepts a mentions array", () => {
    expect(parseReplyArgs({ room: "r", text: "t", mentions: ["a"] }).mentions).toEqual([
      "a",
    ]);
  });

  it("rejects missing room or text", () => {
    expect(() => parseReplyArgs({ text: "t" })).toThrow(/room/);
    expect(() => parseReplyArgs({ room: "r" })).toThrow(/text/);
  });

  it("rejects non-string mentions", () => {
    expect(() => parseReplyArgs({ room: "r", text: "t", mentions: [1] })).toThrow(
      /mentions/,
    );
  });
});

describe("MCP wiring (in-memory)", () => {
  it("exposes a reply tool that forwards to the hub, and injects hub inbound", async () => {
    const sent: ReplyInput[] = [];
    let events: HubClientEvents | undefined;
    const channel = buildChannel(cfg(), {
      logger: () => {},
      createHub: (evts) => {
        events = evts;
        return {
          start() {},
          stop() {},
          sendReply: (reply) => sent.push(reply),
        };
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await channel.mcp.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    // reply tool is discoverable
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("reply");

    // calling it forwards to the hub
    await client.callTool({
      name: "reply",
      arguments: { room: "-100", text: "pong", mentions: ["re-infra"] },
    });
    expect(sent).toEqual([{ room: "-100", text: "pong", mentions: ["re-infra"] }]);

    // a hub inbound triggers a channel injection notification
    const noteSpy = vi
      .spyOn(channel.mcp, "notification")
      .mockResolvedValue(undefined);
    events?.onInbound(humanFrame("hi there"));
    expect(noteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "notifications/claude/channel" }),
    );

    await client.close();
    await channel.mcp.close();
  });
});
