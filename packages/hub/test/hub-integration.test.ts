import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type {
  ChannelConfig,
  InboundFrame,
  InboundMessage,
} from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import { waitFor, delay } from "./helpers.js";

function hubConfig() {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "user1",
    HUB_BIND_HOST: "127.0.0.1",
    HUB_BIND_PORT: "0",
    HUB_ADAPTER: "loopback",
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
  };
}

function humanInbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: "loopback",
    room: "-100",
    fromKind: "human",
    fromId: "user1",
    text: "@re-infra ping",
    mentions: ["re-infra"],
    ...over,
  };
}

let hub: Hub | undefined;
const clients: HubClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  if (hub) await hub.stop();
  hub = undefined;
});

async function startHub(): Promise<{ adapter: LoopbackAdapter; url: string }> {
  const adapter = new LoopbackAdapter();
  hub = new Hub({ config: hubConfig(), adapter, logger: () => {} });
  await hub.start();
  return { adapter, url: `ws://127.0.0.1:${hub.port()}` };
}

function attach(
  url: string,
  agent: string,
): { client: HubClient; injected: InboundFrame[]; registered: () => boolean } {
  const injected: InboundFrame[] = [];
  let isRegistered = false;
  const client = new HubClient(channelConfig(url, agent), {
    onInbound: (f) => injected.push(f),
    onRegistered: () => {
      isRegistered = true;
    },
  });
  clients.push(client);
  client.start();
  return { client, injected, registered: () => isRegistered };
}

describe("hub ↔ real channel integration", () => {
  it("real channel attaches; inbound routes to it; reply returns via the adapter", async () => {
    const { adapter, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);
    expect(hub!.connectedAgents()).toContain("re-infra");

    await adapter.deliver(humanInbound());
    await waitFor(() => a.injected.length >= 1);
    expect(a.injected[0].message.text).toBe("@re-infra ping");

    a.client.sendReply({ room: "-100", text: "pong" });
    const sent = await adapter.waitForSent();
    expect(sent.out).toMatchObject({ agent: "re-infra", text: "pong", kind: "reply" });
    expect(sent.target).toMatchObject({ adapter: "loopback", room: "-100" });
  });

  it("delivers only to explicitly mentioned agents", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    await adapter.deliver(humanInbound({ mentions: ["re-gitops"] }));
    await waitFor(() => gitops.injected.length >= 1);
    await delay(30);
    expect(gitops.injected).toHaveLength(1);
    expect(infra.injected).toHaveLength(0);
  });

  it("lets a session restart and re-attach without disturbing routing", async () => {
    const { adapter, url } = await startHub();
    const first = attach(url, "re-infra");
    await waitFor(first.registered);
    first.client.stop(); // simulate a crash/restart
    await delay(30);

    const second = attach(url, "re-infra");
    await waitFor(second.registered);

    await adapter.deliver(humanInbound({ text: "after restart" }));
    await waitFor(() => second.injected.length >= 1);
    expect(second.injected[0].message.text).toBe("after restart");
  });

  it("drops inbound from a non-allowlisted human", async () => {
    const { adapter, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    await adapter.deliver(humanInbound({ fromId: "stranger" }));
    await delay(50);
    expect(a.injected).toHaveLength(0);
  });

  it("posts an in-room notice when a tagged agent is offline", async () => {
    const { adapter } = await startHub();
    // no session for "ghost"
    await adapter.deliver(humanInbound({ mentions: ["ghost"] }));
    const notice = await adapter.waitForSent((s) => s.out.kind === "notice");
    expect(notice.out.text).toContain("@ghost");
  });

  it("rejects a channel presenting the wrong secret", async () => {
    const { url } = await startHub();
    const injected: InboundFrame[] = [];
    let hubError: string | undefined;
    const client = new HubClient(
      { ...channelConfig(url, "re-infra"), sessionSecret: "wrong" },
      {
        onInbound: (f) => injected.push(f),
        onHubError: (code) => {
          hubError = code;
        },
      },
    );
    clients.push(client);
    client.start();
    await waitFor(() => hubError !== undefined);
    expect(hubError).toBe("auth_failed");
    expect(hub!.connectedAgents()).not.toContain("re-infra");
  });
});
