import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import { HubClient } from "../src/index.js";
import type { ChannelConfig, InboundFrame } from "@claude-telegram-hub/protocol";

interface FakeHub {
  url: string;
  registrations: Array<{ agent: string; secret: string; protocolVersion: number }>;
  server: WebSocketServer;
  close: () => Promise<void>;
}

/** A fake hub that echoes each reply back as an inbound message. */
async function startEchoHub(): Promise<FakeHub> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const registrations: FakeHub["registrations"] = [];

  wss.on("connection", (ws: WsSocket) => {
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === "register") {
        registrations.push({
          agent: String(frame.agent),
          secret: String(frame.secret),
          protocolVersion: Number(frame.protocolVersion),
        });
        ws.send(
          JSON.stringify({
            type: "registered",
            agent: frame.agent,
            protocolVersion: frame.protocolVersion,
          }),
        );
      } else if (frame.type === "reply") {
        ws.send(
          JSON.stringify({
            type: "inbound",
            message: {
              adapter: "echo",
              room: frame.room,
              fromKind: "human",
              fromId: "echo",
              text: frame.text,
              mentions: frame.mentions ?? [],
            },
          }),
        );
      }
    });
  });

  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    registrations,
    server: wss,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

function cfg(url: string, over: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    hubUrl: url,
    sessionSecret: "test-secret",
    agent: "test-agent",
    logLevel: "error",
    reconnectInitialMs: 30,
    reconnectMaxMs: 120,
    maxFileMb: 50,
    ...over,
  };
}

function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (pred()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timeout"));
      }
    }, 10);
  });
}

let client: HubClient | undefined;
let hub: FakeHub | undefined;

afterEach(async () => {
  client?.stop();
  if (hub) await hub.close();
  client = undefined;
  hub = undefined;
});

describe("HubClient", () => {
  it("registers with agent, secret, and protocol version on connect", async () => {
    hub = await startEchoHub();
    let registered = false;
    client = new HubClient(cfg(hub.url), {
      onInbound: () => {},
      onRegistered: () => {
        registered = true;
      },
    });
    client.start();
    await waitFor(() => registered);
    expect(hub.registrations).toHaveLength(1);
    expect(hub.registrations[0]).toMatchObject({
      agent: "test-agent",
      secret: "test-secret",
    });
    expect(hub.registrations[0].protocolVersion).toBeGreaterThan(0);
  });

  it("round-trips: reply -> hub echo -> inbound injection", async () => {
    hub = await startEchoHub();
    const inbound: InboundFrame[] = [];
    let registered = false;
    client = new HubClient(cfg(hub.url), {
      onInbound: (frame) => inbound.push(frame),
      onRegistered: () => {
        registered = true;
      },
    });
    client.start();
    await waitFor(() => registered);

    client.sendReply({ room: "-100", text: "pong" });
    await waitFor(() => inbound.length >= 1);
    expect(inbound[0].message.text).toBe("pong");
    expect(inbound[0].message.room).toBe("-100");
  });

  it("reconnects and re-registers after the connection drops", async () => {
    hub = await startEchoHub();
    let registrations = 0;
    client = new HubClient(cfg(hub.url), {
      onInbound: () => {},
      onRegistered: () => {
        registrations += 1;
      },
    });
    client.start();
    await waitFor(() => registrations >= 1);

    // Force-drop every server-side socket; the client should reconnect.
    for (const socket of hub.server.clients) socket.terminate();
    await waitFor(() => registrations >= 2, 3000);
    expect(registrations).toBeGreaterThanOrEqual(2);
  });

  it("ignores malformed and unrecognized frames without crashing", async () => {
    hub = await startEchoHub();
    let registered = false;
    const inbound: InboundFrame[] = [];
    client = new HubClient(cfg(hub.url), {
      onInbound: (f) => inbound.push(f),
      onRegistered: () => {
        registered = true;
      },
    });
    client.start();
    await waitFor(() => registered);
    // Send junk from the hub side.
    for (const socket of hub.server.clients) {
      socket.send("not json");
      socket.send(JSON.stringify({ type: "bogus" }));
    }
    // Give it a beat; nothing should have been injected.
    await new Promise((r) => setTimeout(r, 50));
    expect(inbound).toHaveLength(0);
  });
});

describe("HubClient connect headers (#123)", () => {
  /** A hub behind an Access-like gate: the upgrade needs a header, else 403. */
  async function startGatedHub(): Promise<FakeHub> {
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (info, done) =>
        info.req.headers["cf-access-client-id"] === "id-1" ? done(true) : done(false, 403, "Forbidden"),
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const registrations: FakeHub["registrations"] = [];
    wss.on("connection", (ws: WsSocket) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "register") {
          registrations.push({ agent: String(frame.agent), secret: String(frame.secret), protocolVersion: Number(frame.protocolVersion) });
          ws.send(JSON.stringify({ type: "registered", agent: frame.agent, protocolVersion: frame.protocolVersion }));
        }
      });
    });
    const port = (wss.address() as AddressInfo).port;
    return {
      url: `ws://127.0.0.1:${port}`,
      registrations,
      server: wss,
      close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
    };
  }

  it("sends the configured headers on the upgrade and registers", async () => {
    hub = await startGatedHub();
    let registered = false;
    client = new HubClient(cfg(hub.url, { headers: { "CF-Access-Client-Id": "id-1", "CF-Access-Client-Secret": "s-1" } }), {
      onInbound: () => {},
      onRegistered: () => {
        registered = true;
      },
    });
    client.start();
    await waitFor(() => registered);
    expect(hub.registrations[0].agent).toBe("test-agent");
  });

  it("logs a 403 on the upgrade as blocked before the hub, without header values", async () => {
    hub = await startGatedHub();
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    client = new HubClient(cfg(hub.url, { headers: { "CF-Access-Client-Id": "wrong", "CF-Access-Client-Secret": "s-1" } }), {
      onInbound: () => {},
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
    });
    client.start();
    await waitFor(() => logs.some((l) => l.msg.startsWith("blocked before reaching the hub")));
    const blocked = logs.find((l) => l.msg.startsWith("blocked before reaching the hub"));
    expect(blocked?.fields).toEqual({ headers: ["CF-Access-Client-Id", "CF-Access-Client-Secret"] });
    expect(JSON.stringify(logs)).not.toContain("s-1");
    expect(hub.registrations).toHaveLength(0);
  });
});
