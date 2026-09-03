import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundFrame, InboundMessage } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import { waitFor, delay } from "./helpers.js";

function hubConfig(over: Record<string, string> = {}) {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "user1",
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

function humanInbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: "loopback",
    room: "-100",
    fromKind: "human",
    fromId: "user1",
    text: "@all stand down",
    mentions: ["all"],
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
  return { client, injected, registered: () => registered };
}

describe("broadcast (@all)", () => {
  it("expands a human @all to every live agent", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    await adapter.deliver(humanInbound());
    await waitFor(() => infra.injected.length >= 1 && gitops.injected.length >= 1);
    expect(infra.injected[0].message.text).toBe("@all stand down");
    expect(gitops.injected[0].message.text).toBe("@all stand down");
  });

  it("does not post offline notices for a broadcast (live agents only)", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    await adapter.deliver(humanInbound());
    await waitFor(() => infra.injected.length >= 1);
    await delay(30);
    expect(adapter.sent.filter((s) => s.out.kind === "notice")).toHaveLength(0);
  });

  it("composes broadcast with an explicitly-named agent (deduped)", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    // @all @re-infra — re-infra must not be injected twice
    await adapter.deliver(
      humanInbound({ text: "@all @re-infra note", mentions: ["all", "re-infra"] }),
    );
    await waitFor(() => infra.injected.length >= 1);
    await delay(30);
    expect(infra.injected).toHaveLength(1);
  });

  it("treats @all as a literal name when broadcast is disabled", async () => {
    const { adapter, url } = await startHub({ HUB_BROADCAST: "off" });
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    await adapter.deliver(humanInbound());
    // no agent named "all" → an offline notice, and re-infra is NOT injected
    const notice = await adapter.waitForSent((s) => s.out.kind === "notice");
    expect(notice.out.text).toContain("@all");
    expect(infra.injected).toHaveLength(0);
  });

  it("does not let an agent broadcast (broadcast token dropped from a reply)", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    // re-infra tries to @all — must not fan out to gitops
    infra.client.sendReply({ room: "-100", text: "@all heads up", mentions: ["all"] });
    await adapter.waitForSent((s) => s.out.kind === "reply"); // visible copy posted
    await delay(40);
    expect(gitops.injected).toHaveLength(0);
  });
});

describe("operator-broadcast (HUB_OPERATOR_BROADCAST) — delivery fix (#109)", () => {
  it("fans a NO-mention human message to every live agent when enabled", async () => {
    // Without it, a no-mention human message is dropped ("no mentions; not routing").
    const { adapter, url } = await startHub({ HUB_OPERATOR_BROADCAST: "on" });
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    await adapter.deliver(humanInbound({ text: "go", mentions: [] }));
    await waitFor(() => infra.injected.length >= 1 && gitops.injected.length >= 1);
    expect(infra.injected[0].message.text).toBe("go");
    expect(gitops.injected[0].message.text).toBe("go");
  });

  it("fans a SUBSET-mention human message to every live agent when enabled", async () => {
    // The B3 failure mode: operator @-tags a subset but means the team.
    const { adapter, url } = await startHub({ HUB_OPERATOR_BROADCAST: "on" });
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    await adapter.deliver(humanInbound({ text: "@re-infra go", mentions: ["re-infra"] }));
    // re-gitops was NOT tagged but must still receive the operator's word
    await waitFor(() => infra.injected.length >= 1 && gitops.injected.length >= 1);
    expect(gitops.injected[0].message.text).toBe("@re-infra go");
  });

  it("drops a no-mention human message when disabled (default, backward-compat)", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    await adapter.deliver(humanInbound({ text: "go", mentions: [] }));
    await delay(40);
    expect(infra.injected).toHaveLength(0);
  });

  it("delivers only to the named subset when disabled (default)", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    await adapter.deliver(humanInbound({ text: "@re-infra go", mentions: ["re-infra"] }));
    await waitFor(() => infra.injected.length >= 1);
    await delay(40);
    expect(gitops.injected).toHaveLength(0); // not tagged, not fanned
  });
});
