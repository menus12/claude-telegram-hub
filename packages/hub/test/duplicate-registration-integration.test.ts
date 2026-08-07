import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, ErrorCode } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import { waitFor } from "./helpers.js";

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
  const errors: ErrorCode[] = [];
  const client = new HubClient(channelConfig(url, agent), {
    onInbound: () => {},
    onRegistered: () => {
      registered = true;
    },
    onHubError: (code) => errors.push(code),
  });
  clients.push(client);
  client.start();
  return { client, registered: () => registered, errors };
}

describe("duplicate-name registration", () => {
  it("rejects a second session for a live name and notices the room; incumbent stays", async () => {
    const { adapter, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    const b = attach(url, "re-infra");
    await waitFor(() => b.errors.includes("name_in_use"));

    const notice = await adapter.waitForSent((s) => s.out.text.includes("second session"));
    expect(notice.out).toMatchObject({ agent: "hub", kind: "notice" });
    expect(notice.out.text).toContain("@re-infra");

    // the incumbent alone still holds the name
    expect(hub?.connectedAgents()).toEqual(["re-infra"]);
    expect(a.registered()).toBe(true);
  });

  it("replace policy lets the newcomer take over (no rejection)", async () => {
    const { url } = await startHub({ HUB_DUPLICATE_NAME: "replace" });
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    const b = attach(url, "re-infra");
    await waitFor(b.registered);
    expect(b.errors).toEqual([]);
    expect(hub?.connectedAgents()).toEqual(["re-infra"]);
  });
});
