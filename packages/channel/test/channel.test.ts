import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChannel,
  buildInboundNotification,
  parseReplyArgs,
  parseSendFileArgs,
} from "../src/index.js";
import type { HubClientEvents, ReplyInput, SendFileInput } from "../src/index.js";
import type { ChannelConfig, FilePayload, InboundFrame } from "@claude-telegram-hub/protocol";

function cfg(): ChannelConfig {
  return {
    hubUrl: "ws://unused:8787",
    sessionSecret: "s",
    agent: "a",
    logLevel: "error",
    reconnectInitialMs: 50,
    reconnectMaxMs: 100,
    maxFileMb: 50,
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

function fileFrame(text: string): InboundFrame {
  return {
    ...humanFrame(text),
    file: {
      filename: "rufus.ini",
      mimeType: "application/octet-stream",
      dataBase64: Buffer.from("[boot]\nkey=value").toString("base64"),
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

  it("surfaces an attachment path in meta and inline in the content", () => {
    const note = buildInboundNotification(fileFrame("look"), "/tmp/x/rufus.ini");
    expect(note.params.meta.attachment_path).toBe("/tmp/x/rufus.ini");
    expect(note.params.meta.attachment_name).toBe("rufus.ini");
    expect(note.params.content).toContain("look");
    expect(note.params.content).toContain("/tmp/x/rufus.ini");
  });

  it("announces an attached file even when it couldn't be saved (never silent)", () => {
    const note = buildInboundNotification(fileFrame("look")); // no path → save failed
    expect(note.params.meta.attachment_name).toBe("rufus.ini");
    expect(note.params.meta.attachment_path).toBeUndefined();
    expect(note.params.content).toContain("could not be saved");
  });

  it("does not add attachment meta to a fileless message", () => {
    const note = buildInboundNotification(humanFrame("hi"), "/tmp/x/shot.png");
    expect(note.params.meta.attachment_path).toBeUndefined();
    expect(note.params.meta.attachment_name).toBeUndefined();
  });
});

describe("parseSendFileArgs", () => {
  it("accepts room + path (+ optional caption)", () => {
    expect(parseSendFileArgs({ room: "-100", path: "/a/b.png" })).toEqual({
      room: "-100",
      path: "/a/b.png",
    });
    expect(parseSendFileArgs({ room: "r", path: "/p", caption: "hi" }).caption).toBe("hi");
  });

  it("rejects missing room or path, and a non-string caption", () => {
    expect(() => parseSendFileArgs({ path: "/p" })).toThrow(/room/);
    expect(() => parseSendFileArgs({ room: "r" })).toThrow(/path/);
    expect(() => parseSendFileArgs({ room: "r", path: "/p", caption: 1 })).toThrow(/caption/);
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

  it("passes through a boolean voice flag and rejects a non-boolean", () => {
    expect(parseReplyArgs({ room: "r", text: "t", voice: true }).voice).toBe(true);
    expect(parseReplyArgs({ room: "r", text: "t" }).voice).toBeUndefined();
    expect(() => parseReplyArgs({ room: "r", text: "t", voice: "yes" })).toThrow(/voice/);
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
          sendReply: (reply) => void sent.push(reply),
          sendFile() {},
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

  it("exposes a send_file tool that reads a local file and forwards bytes to the hub", async () => {
    const files: SendFileInput[] = [];
    const channel = buildChannel(cfg(), {
      logger: () => {},
      createHub: () => ({
        start() {},
        stop() {},
        sendReply() {},
        sendFile: (f) => void files.push(f),
      }),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await channel.mcp.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("send_file");

    const dir = await mkdtemp(join(tmpdir(), "cth-tool-"));
    try {
      const path = join(dir, "chart.png");
      await writeFile(path, "PNG-BYTES");
      await client.callTool({
        name: "send_file",
        arguments: { room: "-100", path, caption: "the chart" },
      });
      expect(files).toHaveLength(1);
      expect(files[0].room).toBe("-100");
      expect(files[0].caption).toBe("the chart");
      const payload: FilePayload = files[0].file;
      expect(payload.filename).toBe("chart.png");
      expect(payload.mimeType).toBe("image/png");
      expect(Buffer.from(payload.dataBase64, "base64").toString()).toBe("PNG-BYTES");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    await client.close();
    await channel.mcp.close();
  });

  it("materializes an inbound file to a local path and injects that path (end to end)", async () => {
    let events: HubClientEvents | undefined;
    const channel = buildChannel(cfg(), {
      logger: () => {},
      createHub: (evts) => {
        events = evts;
        return { start() {}, stop() {}, sendReply() {}, sendFile() {} };
      },
    });
    const noteSpy = vi.spyOn(channel.mcp, "notification").mockResolvedValue(undefined);

    // The hub pushes an inbound message carrying file bytes (as after downloading a
    // Telegram document). The channel must save it and inject the local path.
    events?.onInbound(fileFrame("@a can you see this file?"));

    await vi.waitFor(() => expect(noteSpy).toHaveBeenCalled());
    const note = noteSpy.mock.calls[0][0] as unknown as {
      params: { content: string; meta: Record<string, string> };
    };
    const savedPath = note.params.meta.attachment_path;
    expect(savedPath).toBeTruthy();
    expect(note.params.content).toContain("attachment saved to");
    try {
      expect((await readFile(savedPath)).toString()).toBe("[boot]\nkey=value");
    } finally {
      await rm(savedPath, { force: true });
    }

    await channel.mcp.close();
  });
});
