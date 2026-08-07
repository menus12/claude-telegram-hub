import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import { waitFor, delay } from "./helpers.js";

function hubConfig(over: Record<string, string> = {}) {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "user1",
    HUB_ROOMS: "-100",
    HUB_BIND_HOST: "127.0.0.1",
    HUB_BIND_PORT: "0",
    HUB_ADAPTER: "loopback",
    HUB_LOG_LEVEL: "error",
    ...over,
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

let hub: Hub | undefined;
const clients: HubClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  if (hub) await hub.stop();
  hub = undefined;
});

async function startHub(over: Record<string, string> = {}): Promise<{
  adapter: LoopbackAdapter;
  url: string;
}> {
  const adapter = new LoopbackAdapter();
  hub = new Hub({ config: hubConfig(over), adapter, logger: () => {} });
  await hub.start();
  return { adapter, url: `ws://127.0.0.1:${hub.port()}` };
}

function attach(url: string, agent: string) {
  let registered = false;
  const client = new HubClient(channelConfig(url, agent), {
    onInbound: () => {},
    onRegistered: () => {
      registered = true;
    },
  });
  clients.push(client);
  client.start();
  return { client, registered: () => registered };
}

describe("presence notices", () => {
  it("announces an agent online in the configured room on connect", async () => {
    const { adapter, url } = await startHub({ HUB_PRESENCE: "on" });
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    const online = await adapter.waitForSent((s) => s.out.text.includes("online"));
    expect(online.out).toMatchObject({ agent: "hub", kind: "notice" });
    expect(online.out.text).toBe("@re-infra is online.");
    expect(online.target.room).toBe("-100");
  });

  it("announces offline after the grace window when a session disconnects", async () => {
    const { adapter, url } = await startHub({ HUB_PRESENCE: "on", HUB_PRESENCE_GRACE_MS: "40" });
    const a = attach(url, "re-infra");
    await waitFor(a.registered);
    await adapter.waitForSent((s) => s.out.text.includes("online"));

    a.client.stop(); // disconnect
    const offline = await adapter.waitForSent((s) => s.out.text.includes("offline"));
    expect(offline.out.text).toBe("@re-infra is offline.");
    expect(offline.target.room).toBe("-100");
  });

  it("stays silent when presence is disabled (the default)", async () => {
    const { adapter, url } = await startHub(); // HUB_PRESENCE unset → off
    const a = attach(url, "re-infra");
    await waitFor(a.registered);
    await delay(50);
    expect(adapter.sent).toHaveLength(0);
  });
});
