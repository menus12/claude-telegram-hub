import { webcrypto } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../../hub/src/index.js";
import { waitFor } from "../../hub/test/helpers.js";
import { BridgeServer, TokenStore, parseTokens, sha256Hex, type BridgeConfig } from "../src/index.js";

if (!globalThis.crypto) Object.assign(globalThis, { crypto: webcrypto });

const TOKEN = "t".repeat(64);
const OTHER_TOKEN = "o".repeat(64);
const ROOM = "-100";

let hub: Hub | undefined;
let bridge: BridgeServer | undefined;
const clients: Client[] = [];
const locals: HubClient[] = [];
let clockOffset = 0;

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const l of locals.splice(0)) l.stop();
  if (bridge) await bridge.stop();
  if (hub) await hub.stop();
  hub = undefined;
  bridge = undefined;
  clockOffset = 0;
});

async function setup(over: Partial<BridgeConfig> = {}) {
  const adapter = new LoopbackAdapter();
  hub = new Hub({
    config: loadHubConfig({
      HUB_SESSION_SECRET: "s3cr3t",
      HUB_ALLOWLIST: "user1",
      HUB_ROOMS: ROOM,
      HUB_BIND_HOST: "127.0.0.1",
      HUB_BIND_PORT: "0",
      HUB_ADAPTER: "loopback",
      HUB_LOG_LEVEL: "error",
    }),
    adapter,
    logger: () => {},
  });
  await hub.start();
  const hubUrl = `ws://127.0.0.1:${hub.port()}`;
  const config: BridgeConfig = {
    hubUrl,
    sessionSecret: "s3cr3t",
    bindHost: "127.0.0.1",
    bindPort: 0,
    tokensFile: "(inline)",
    defaultRoom: ROOM,
    agentPrefix: "cloud-",
    ttlMs: 60_000,
    waitMaxS: 840,
    progressEveryS: 1,
    queueMax: 50,
    joinTimeoutMs: 3000,
    requestsPerMin: 1000,
    sendsPerMin: 100,
    unauthPerMin: 100,
    maxBodyBytes: 64 * 1024,
    logLevel: "error",
    ...over,
  };
  const tokens = new TokenStore(
    parseTokens(`testbed ${sha256Hex(TOKEN)}\nrouter ${sha256Hex(OTHER_TOKEN)}`),
  );
  bridge = new BridgeServer({ config, tokens, logger: () => {}, now: () => Date.now() + clockOffset });
  await bridge.start();
  return { adapter, hubUrl, base: `http://127.0.0.1:${bridge.port()}` };
}

async function connect(base: string, token = TOKEN): Promise<Client> {
  const client = new Client({ name: "cloud-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const raw = r.content[0]?.text ?? "";
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  return { isError: r.isError === true, raw, json: json ?? {} };
}

function operatorSays(adapter: LoopbackAdapter, text: string, mentions: string[]) {
  return adapter.deliver({ adapter: "loopback", room: ROOM, fromKind: "human", fromId: "user1", text, mentions });
}

describe("bridge HTTP surface", () => {
  it("serves /healthz open, requires the bearer elsewhere, and rate-limits unauthenticated callers", async () => {
    const { base } = await setup({ unauthPerMin: 2 });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(401);
    expect(
      (await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(429);
    expect((await fetch(`${base}/other`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it("serves the cloud instructions and the four tools", async () => {
    const { base } = await setup();
    const client = await connect(base);
    expect(client.getInstructions()).toContain("SIGNALING BUS");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["join", "leave", "send", "wait"]);
  });
});

describe("cloud agent lifecycle", () => {
  it("join registers a cloud-* agent on the hub and notices the room", async () => {
    const { adapter, base } = await setup();
    const client = await connect(base);
    const r = await call(client, "join", { name: "cheburnet_router", task: "fix #42 routing" });
    expect(r.json).toMatchObject({ agent: "cloud-cheburnet-router", rebound: false, wait_max_s: 840 });
    expect(typeof r.json.handle).toBe("string");
    expect(hub?.connectedAgents()).toContain("cloud-cheburnet-router");
    const notice = await adapter.waitForSent((s) => s.out.text.includes("joined"));
    expect(notice.out).toMatchObject({ agent: "cloud-cheburnet-router" });
    expect(notice.out.text).toContain("fix #42 routing");
  });

  it("tools other than join fail until joined", async () => {
    const { base } = await setup();
    const client = await connect(base);
    const r = await call(client, "send", { text: "hi" });
    expect(r.isError).toBe(true);
    expect(r.raw).toContain("not joined");
  });

  it("wait blocks until a message for the agent arrives, with progress ticks", async () => {
    const { adapter, base } = await setup();
    const client = await connect(base);
    await call(client, "join", { name: "router", task: "t" });

    let ticks = 0;
    const pending = client.callTool(
      { name: "wait", arguments: { timeout_s: 30 } },
      undefined,
      { onprogress: () => ticks++, timeout: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 1300));
    await operatorSays(adapter, "@cloud-router status?", ["cloud-router"]);
    const r = (await pending) as { content: Array<{ text: string }> };
    const body = JSON.parse(r.content[0].text) as { messages: Array<Record<string, string>> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ room: ROOM, from_kind: "human", from_id: "user1" });
    expect(body.messages[0].text).toContain("status?");
    expect(ticks).toBeGreaterThanOrEqual(1);
  });

  it("queues messages while no wait is pending; send reports them as pending and replies into the room", async () => {
    const { adapter, base } = await setup();
    const client = await connect(base);
    await call(client, "join", { name: "router", task: "t" });
    await operatorSays(adapter, "@cloud-router one", ["cloud-router"]);
    await operatorSays(adapter, "@cloud-router two", ["cloud-router"]);
    await new Promise((r) => setTimeout(r, 100));

    const sent = await call(client, "send", { text: "on it", no_reply: true });
    expect(sent.json).toMatchObject({ ok: true, room: ROOM, pending: 2 });
    const out = await adapter.waitForSent((s) => s.out.text.includes("on it"));
    expect(out.out.agent).toBe("cloud-router");

    const r = await call(client, "wait", { timeout_s: 5 });
    expect((r.json.messages as unknown[]).length).toBe(2);
  });

  it("an empty wait returns after its timeout", async () => {
    const { base } = await setup();
    const client = await connect(base);
    await call(client, "join", { name: "router", task: "t" });
    const t0 = Date.now();
    const r = await call(client, "wait", { timeout_s: 1 });
    expect(r.json).toMatchObject({ messages: [], dropped: 0 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it("takes the next free name when the hub reports name_in_use (local agents keep theirs)", async () => {
    const { base, hubUrl } = await setup();
    let registered = false;
    const local = new HubClient(
      {
        hubUrl,
        sessionSecret: "s3cr3t",
        agent: "cloud-router",
        logLevel: "error",
        reconnectInitialMs: 30,
        reconnectMaxMs: 120,
        maxFileMb: 1,
      },
      { onInbound: () => {}, onRegistered: () => (registered = true) },
    );
    locals.push(local);
    local.start();
    await waitFor(() => registered);

    const client = await connect(base);
    const r = await call(client, "join", { name: "router", task: "t" });
    expect(r.json.agent).toBe("cloud-router-2");
  });

  it("a second cloud session with the same name gets a suffix", async () => {
    const { base } = await setup();
    const a = await call(await connect(base), "join", { name: "router", task: "a" });
    const b = await call(await connect(base), "join", { name: "router", task: "b" });
    expect([a.json.agent, b.json.agent]).toEqual(["cloud-router", "cloud-router-2"]);
  });

  it("re-binds by handle from a new MCP session (same token only), keeping queued messages", async () => {
    const { adapter, base } = await setup();
    const first = await call(await connect(base), "join", { name: "router", task: "t" });
    await operatorSays(adapter, "@cloud-router while you were away", ["cloud-router"]);
    await new Promise((r) => setTimeout(r, 100));

    const again = await connect(base);
    const r = await call(again, "join", { name: "router", task: "t", handle: first.json.handle });
    expect(r.json).toMatchObject({ agent: "cloud-router", rebound: true, pending: 1 });
    const w = await call(again, "wait", { timeout_s: 1 });
    expect((w.json.messages as Array<{ text: string }>)[0].text).toContain("while you were away");

    const foreign = await call(await connect(base, OTHER_TOKEN), "join", {
      name: "router",
      task: "t",
      handle: first.json.handle,
    });
    expect(foreign.json).toMatchObject({ agent: "cloud-router-2", rebound: false });
  });

  it("leave notices the room and drops the agent from the hub", async () => {
    const { adapter, base } = await setup();
    const client = await connect(base);
    await call(client, "join", { name: "router", task: "t" });
    await call(client, "leave", { reason: "PR merged" });
    const notice = await adapter.waitForSent((s) => s.out.text.includes("left"));
    expect(notice.out.text).toContain("PR merged");
    await waitFor(() => !(hub?.connectedAgents() ?? []).includes("cloud-router"));
    expect((await call(client, "send", { text: "x" })).isError).toBe(true);
  });

  it("auto-leaves an agent idle past the TTL, but not one with a pending wait", async () => {
    const { adapter, base } = await setup({ ttlMs: 60_000 });
    const idle = await connect(base);
    await call(idle, "join", { name: "idle", task: "t" });
    const busy = await connect(base);
    await call(busy, "join", { name: "busy", task: "t" });
    const waiting = busy.callTool({ name: "wait", arguments: { timeout_s: 30 } }, undefined, { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 100));

    clockOffset = 61_000;
    bridge?.sweep();
    expect(bridge?.agents()).toEqual(["cloud-busy"]);
    const notice = await adapter.waitForSent((s) => s.out.agent === "cloud-idle" && s.out.text.includes("left"));
    expect(notice.out.text).toContain("idle");
    await operatorSays(adapter, "@cloud-busy ping", ["cloud-busy"]);
    await waiting;
  });

  it("rate-limits send per agent", async () => {
    const { base } = await setup({ sendsPerMin: 2 });
    const client = await connect(base);
    await call(client, "join", { name: "router", task: "t" });
    expect((await call(client, "send", { text: "1", no_reply: true })).isError).toBe(false);
    expect((await call(client, "send", { text: "2", no_reply: true })).isError).toBe(false);
    const third = await call(client, "send", { text: "3", no_reply: true });
    expect(third.isError).toBe(true);
    expect(third.raw).toContain("rate limited");
  });
});
