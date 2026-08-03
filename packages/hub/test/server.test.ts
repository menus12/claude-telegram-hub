import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@claude-telegram-hub/protocol";
import type { ReplyFrame } from "@claude-telegram-hub/protocol";
import { AgentRegistry, SessionServer } from "../src/index.js";
import { waitFor } from "./helpers.js";

interface Harness {
  server: SessionServer;
  registry: AgentRegistry;
  replies: Array<{ agent: string; reply: ReplyFrame }>;
  setReady: (v: boolean) => void;
}

function makeServer(registerTimeoutMs = 500): Harness {
  const registry = new AgentRegistry();
  const replies: Harness["replies"] = [];
  let ready = true;
  const server = new SessionServer({
    host: "127.0.0.1",
    port: 0,
    sessionSecret: "s3cr3t",
    registry,
    onReply: (agent, reply) => replies.push({ agent, reply }),
    isReady: () => ready,
    logger: () => {},
    registerTimeoutMs,
  });
  return {
    server,
    registry,
    replies,
    setReady: (v) => {
      ready = v;
    },
  };
}

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data: WebSocket.RawData) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>),
    );
  });
}

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) await harness.server.close();
  harness = undefined;
});

describe("SessionServer", () => {
  it("accepts a valid registration and replies `registered`", async () => {
    harness = makeServer();
    await harness.server.listen();
    const ws = await open(`ws://127.0.0.1:${harness.server.port()}`);
    ws.send(
      JSON.stringify({
        type: "register",
        protocolVersion: PROTOCOL_VERSION,
        agent: "re-infra",
        secret: "s3cr3t",
      }),
    );
    const frame = await nextMessage(ws);
    expect(frame.type).toBe("registered");
    expect(frame.agent).toBe("re-infra");
    expect(harness.registry.has("re-infra")).toBe(true);
    ws.close();
  });

  it("rejects a bad secret with auth_failed", async () => {
    harness = makeServer();
    await harness.server.listen();
    const ws = await open(`ws://127.0.0.1:${harness.server.port()}`);
    ws.send(
      JSON.stringify({
        type: "register",
        protocolVersion: PROTOCOL_VERSION,
        agent: "x",
        secret: "wrong",
      }),
    );
    const frame = await nextMessage(ws);
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("auth_failed");
    expect(harness.registry.has("x")).toBe(false);
  });

  it("rejects an incompatible protocol version", async () => {
    harness = makeServer();
    await harness.server.listen();
    const ws = await open(`ws://127.0.0.1:${harness.server.port()}`);
    ws.send(
      JSON.stringify({
        type: "register",
        protocolVersion: PROTOCOL_VERSION + 1,
        agent: "x",
        secret: "s3cr3t",
      }),
    );
    const frame = await nextMessage(ws);
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("version_mismatch");
  });

  it("forwards a reply frame after registration", async () => {
    harness = makeServer();
    await harness.server.listen();
    const ws = await open(`ws://127.0.0.1:${harness.server.port()}`);
    ws.send(
      JSON.stringify({
        type: "register",
        protocolVersion: PROTOCOL_VERSION,
        agent: "re-infra",
        secret: "s3cr3t",
      }),
    );
    await nextMessage(ws); // registered
    ws.send(JSON.stringify({ type: "reply", room: "-100", text: "hi" }));
    await waitFor(() => harness!.replies.length >= 1);
    expect(harness.replies[0].agent).toBe("re-infra");
    expect(harness.replies[0].reply.room).toBe("-100");
    expect(harness.replies[0].reply.text).toBe("hi");
    ws.close();
  });

  it("drops a connection that never registers", async () => {
    harness = makeServer(100);
    await harness.server.listen();
    const ws = await open(`ws://127.0.0.1:${harness.server.port()}`);
    const frame = await nextMessage(ws);
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("bad_request");
  });

  it("serves health and readiness probes", async () => {
    harness = makeServer();
    await harness.server.listen();
    const base = `http://127.0.0.1:${harness.server.port()}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    harness.setReady(false);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
