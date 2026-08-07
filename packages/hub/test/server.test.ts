import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@claude-telegram-hub/protocol";
import type { ReplyFrame } from "@claude-telegram-hub/protocol";
import { AgentRegistry, SessionServer } from "../src/index.js";
import type { Session } from "../src/session.js";
import { waitFor } from "./helpers.js";

interface Harness {
  server: SessionServer;
  registry: AgentRegistry;
  replies: Array<{ agent: string; reply: ReplyFrame }>;
  duplicateRejections: string[];
  setReady: (v: boolean) => void;
}

interface ServerOpts {
  registerTimeoutMs?: number;
  duplicateName?: "reject" | "replace";
  probeAlive?: (session: Session) => Promise<boolean>;
}

function makeServer(opts: ServerOpts = {}): Harness {
  const registry = new AgentRegistry();
  const replies: Harness["replies"] = [];
  const duplicateRejections: string[] = [];
  let ready = true;
  const server = new SessionServer({
    host: "127.0.0.1",
    port: 0,
    sessionSecret: "s3cr3t",
    registry,
    onReply: (agent, reply) => replies.push({ agent, reply }),
    onDuplicateRejected: (agent) => duplicateRejections.push(agent),
    isReady: () => ready,
    logger: () => {},
    registerTimeoutMs: opts.registerTimeoutMs ?? 500,
    ...(opts.duplicateName ? { duplicateName: opts.duplicateName } : {}),
    ...(opts.probeAlive ? { probeAlive: opts.probeAlive } : {}),
  });
  return {
    server,
    registry,
    replies,
    duplicateRejections,
    setReady: (v) => {
      ready = v;
    },
  };
}

function register(ws: WebSocket, agent: string): void {
  ws.send(
    JSON.stringify({ type: "register", protocolVersion: PROTOCOL_VERSION, agent, secret: "s3cr3t" }),
  );
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
    harness = makeServer({ registerTimeoutMs: 100 });
    await harness.server.listen();
    const ws = await open(`ws://127.0.0.1:${harness.server.port()}`);
    const frame = await nextMessage(ws);
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("bad_request");
  });

  it("rejects a duplicate registration while the incumbent is alive", async () => {
    harness = makeServer({ probeAlive: () => Promise.resolve(true) });
    await harness.server.listen();
    const url = `ws://127.0.0.1:${harness.server.port()}`;

    const a = await open(url);
    register(a, "re-infra");
    expect((await nextMessage(a)).type).toBe("registered");

    const b = await open(url);
    register(b, "re-infra");
    const frame = await nextMessage(b);
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("name_in_use");
    expect(frame.fatal).toBe(true);
    expect(harness.duplicateRejections).toEqual(["re-infra"]);
    // the incumbent keeps the name (its session is unchanged)
    expect(harness.registry.has("re-infra")).toBe(true);
    a.close();
    b.close();
  });

  it("takes over the name when the incumbent is dead (probe fails)", async () => {
    harness = makeServer({ probeAlive: () => Promise.resolve(false) });
    await harness.server.listen();
    const url = `ws://127.0.0.1:${harness.server.port()}`;

    const a = await open(url);
    register(a, "re-infra");
    await nextMessage(a); // registered
    const first = harness.registry.get("re-infra");

    const b = await open(url);
    register(b, "re-infra");
    expect((await nextMessage(b)).type).toBe("registered");
    expect(harness.duplicateRejections).toEqual([]);
    // a new session now holds the name (the dead incumbent was taken over)
    expect(harness.registry.get("re-infra")).not.toBe(first);
    b.close();
  });

  it("replace policy takes over without probing", async () => {
    let probed = false;
    harness = makeServer({
      duplicateName: "replace",
      probeAlive: () => {
        probed = true;
        return Promise.resolve(true);
      },
    });
    await harness.server.listen();
    const url = `ws://127.0.0.1:${harness.server.port()}`;

    const a = await open(url);
    register(a, "re-infra");
    await nextMessage(a);

    const b = await open(url);
    register(b, "re-infra");
    expect((await nextMessage(b)).type).toBe("registered");
    expect(probed).toBe(false); // replace never probes
    b.close();
  });

  it("rejects a real duplicate via the ping/pong liveness probe (no injected probe)", async () => {
    harness = makeServer(); // default probe uses ws ping/pong
    await harness.server.listen();
    const url = `ws://127.0.0.1:${harness.server.port()}`;

    const a = await open(url); // a real ws client auto-answers pings
    register(a, "re-infra");
    await nextMessage(a);

    const b = await open(url);
    register(b, "re-infra");
    const frame = await nextMessage(b);
    expect(frame.code).toBe("name_in_use");
    a.close();
    b.close();
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
