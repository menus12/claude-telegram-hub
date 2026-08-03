import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundFrame, InboundMessage } from "@claude-telegram-hub/protocol";
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
    text: "@re-infra hi",
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

describe("group routing + agent↔agent coordination", () => {
  it("delivers a group message to every tagged agent", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    await adapter.deliver(
      humanInbound({ text: "@re-infra @re-gitops sync up", mentions: ["re-infra", "re-gitops"] }),
    );
    await waitFor(() => infra.injected.length >= 1 && gitops.injected.length >= 1);
    expect(infra.injected[0].message.text).toContain("sync up");
    expect(gitops.injected[0].message.text).toContain("sync up");
  });

  it("re-injects an agent→agent hop and posts a human-visible copy", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    // re-infra's session replies, tagging its peer re-gitops
    infra.client.sendReply({ room: "-100", text: "please rollback", mentions: ["re-gitops"] });

    // the peer receives it via re-injection, labeled as agent-origin
    await waitFor(() => gitops.injected.length >= 1);
    const frame = gitops.injected[0];
    expect(frame.message.fromKind).toBe("agent");
    expect(frame.message.fromId).toBe("re-infra");
    expect(frame.message.text).toBe("please rollback");

    // the human sees a visible copy posted to the room
    const sent = await adapter.waitForSent((s) => s.out.kind === "reply");
    expect(sent.out).toMatchObject({ agent: "re-infra", text: "please rollback", kind: "reply" });
    expect(sent.target.room).toBe("-100");
  });

  it("does not re-inject a reply to the replying agent itself (self-tag)", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    infra.client.sendReply({ room: "-100", text: "note to self", mentions: ["re-infra"] });
    // the visible copy is posted...
    await adapter.waitForSent((s) => s.out.kind === "reply");
    await delay(30);
    // ...but nothing is injected back into re-infra
    expect(infra.injected).toHaveLength(0);
  });

  it("posts an in-room notice when a human tags an offline agent", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    await adapter.deliver(humanInbound({ text: "@ghost you up?", mentions: ["ghost"] }));
    const notice = await adapter.waitForSent((s) => s.out.kind === "notice");
    expect(notice.out.text).toContain("@ghost");
    expect(notice.target.room).toBe("-100");
  });

  it("posts an in-room notice when an agent tags an offline peer", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    infra.client.sendReply({ room: "-100", text: "@ghost ping", mentions: ["ghost"] });
    const notice = await adapter.waitForSent((s) => s.out.kind === "notice");
    expect(notice.out.text).toContain("@ghost");
  });

  it("delivers to only the online subset and notices the offline one", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    await adapter.deliver(
      humanInbound({ text: "@re-infra @ghost sync", mentions: ["re-infra", "ghost"] }),
    );
    await waitFor(() => infra.injected.length >= 1);
    const notice = await adapter.waitForSent((s) => s.out.kind === "notice");
    expect(notice.out.text).toContain("@ghost");
    expect(infra.injected[0].message.text).toContain("sync");
  });
});
