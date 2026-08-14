import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundFrame, InboundMessage } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import { waitFor, delay } from "./helpers.js";

const ROOM = "-100";

function hubConfig(hopBudget: string) {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "user1",
    HUB_BIND_HOST: "127.0.0.1",
    HUB_BIND_PORT: "0",
    HUB_ADAPTER: "loopback",
    HUB_HOP_BUDGET: hopBudget,
    HUB_LOG_LEVEL: "error",
  });
}

function channelConfig(url: string, agent: string): ChannelConfig {
  return {
    hubUrl: url,
    sessionSecret: "s3cr3t",
    agent,
    logLevel: "error",
    reconnectInitialMs: 30,
    reconnectMaxMs: 120,
    maxFileMb: 50,
  };
}

function human(text: string, mentions: string[]): InboundMessage {
  return {
    adapter: "loopback",
    room: ROOM,
    fromKind: "human",
    fromId: "user1",
    text,
    mentions,
  };
}

let hub: Hub | undefined;
const clients: HubClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  if (hub) await hub.stop();
  hub = undefined;
});

function attach(url: string, agent: string) {
  const injected: InboundFrame[] = [];
  let registered = false;
  const client = new HubClient(channelConfig(url, agent), {
    onInbound: (f) => injected.push(f),
    onRegistered: () => {
      registered = true;
    },
  });
  clients.push(client);
  client.start();
  const has = (text: string) => injected.some((f) => f.message.text === text);
  return {
    client,
    injected,
    registered: () => registered,
    has,
    await: (text: string) => waitFor(() => has(text)),
  };
}

describe("loop governor (agent↔agent) — end to end", () => {
  it("bounds a chain, freezes with a notice, and a human message resumes it", async () => {
    const adapter = new LoopbackAdapter();
    hub = new Hub({ config: hubConfig("3"), adapter, logger: () => {} });
    await hub.start();
    const url = `ws://127.0.0.1:${hub.port()}`;

    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    // Human opens the coordination thread (budget 3).
    await adapter.deliver(human("kick off", ["re-infra"]));
    await infra.await("kick off");

    // Volley: each hop consumes one unit of budget.
    infra.client.sendReply({ room: ROOM, text: "h1", mentions: ["re-gitops"] }); // 3->2
    await gitops.await("h1");
    gitops.client.sendReply({ room: ROOM, text: "h2", mentions: ["re-infra"] }); // 2->1
    await infra.await("h2");
    infra.client.sendReply({ room: ROOM, text: "h3", mentions: ["re-gitops"] }); // 1->0 freeze
    await gitops.await("h3");

    // The freeze notice is posted to the room.
    const notice = await adapter.waitForSent((s) => s.out.kind === "notice");
    expect(notice.out.text).toContain("paused");

    // The next agent→agent hop is dropped — the peer does not receive it.
    gitops.client.sendReply({ room: ROOM, text: "h4-blocked", mentions: ["re-infra"] });
    await delay(60);
    expect(infra.has("h4-blocked")).toBe(false);

    // A human message refills + unfreezes the thread.
    await adapter.deliver(human("resume please", ["re-infra"]));
    await infra.await("resume please");

    // Agent→agent hops flow again.
    infra.client.sendReply({ room: ROOM, text: "h5", mentions: ["re-gitops"] });
    await gitops.await("h5");
    expect(gitops.has("h5")).toBe(true);
  });

  it("notifies the sender when a frozen thread drops its hop (no silent drop)", async () => {
    const adapter = new LoopbackAdapter();
    hub = new Hub({ config: hubConfig("1"), adapter, logger: () => {} });
    await hub.start();
    const url = `ws://127.0.0.1:${hub.port()}`;

    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    await adapter.deliver(human("go", ["re-infra"]));
    await infra.await("go");
    // budget 1: this hop is delivered and freezes the thread.
    infra.client.sendReply({ room: ROOM, text: "hop1", mentions: ["re-gitops"] });
    await gitops.await("hop1");

    // Frozen: gitops→infra is dropped — but gitops is TOLD it wasn't delivered,
    // rather than waiting forever on a reply that can't arrive.
    gitops.client.sendReply({ room: ROOM, text: "dropped-msg", mentions: ["re-infra"] });
    await waitFor(() =>
      gitops.injected.some((f) => f.message.fromId === "hub" && /NOT delivered/.test(f.message.text)),
    );
    const notice = gitops.injected.find(
      (f) => f.message.fromId === "hub" && /NOT delivered/.test(f.message.text),
    )!;
    expect(notice.message.text).toContain("@re-infra"); // names the undelivered recipient
    expect(notice.message.mentions).toEqual(["re-gitops"]); // addressed back to the sender
    // and the peer still never received the dropped hop
    await delay(60);
    expect(infra.has("dropped-msg")).toBe(false);
  });

  it("never freezes human→agent delivery, only agent→agent hops", async () => {
    const adapter = new LoopbackAdapter();
    hub = new Hub({ config: hubConfig("1"), adapter, logger: () => {} });
    await hub.start();
    const url = `ws://127.0.0.1:${hub.port()}`;

    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    // A single real peer hop exhausts the budget (1) and freezes the thread.
    await adapter.deliver(human("go", ["re-infra"]));
    await infra.await("go");
    infra.client.sendReply({ room: ROOM, text: "hop", mentions: ["re-gitops"] }); // 1->0 freeze
    await gitops.await("hop");
    await adapter.waitForSent((s) => s.out.kind === "notice");

    // Even with the thread frozen, a human message is still delivered.
    await adapter.deliver(human("still here?", ["re-infra"]));
    await infra.await("still here?");
    expect(infra.has("still here?")).toBe(true);
  });
});
