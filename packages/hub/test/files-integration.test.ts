import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, FilePayload, InboundFrame, InboundMessage } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import { waitFor } from "./helpers.js";

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
    maxFileMb: 50,
  };
}

const file: FilePayload = {
  filename: "diagram.png",
  mimeType: "image/png",
  dataBase64: Buffer.from("PNG").toString("base64"),
};

function humanInbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: "loopback",
    room: "-100",
    fromKind: "human",
    fromId: "user1",
    text: "@re-infra see attached",
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

describe("files over the hub (loopback)", () => {
  it("delivers an inbound file to the tagged agent's session", async () => {
    const { adapter, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    await adapter.deliver(humanInbound(), file);
    await waitFor(() => a.injected.length >= 1);

    expect(a.injected[0].message.text).toBe("@re-infra see attached");
    expect(a.injected[0].message.attachments).toBeUndefined(); // set by the real adapter, not loopback
    expect(a.injected[0].file).toEqual(file);
  });

  it("sends an agent's file out to the room through the adapter", async () => {
    const { adapter, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    a.client.sendFile({ room: "-100", file, caption: "the diagram" });
    await waitFor(() => adapter.sentFiles.length >= 1);

    expect(adapter.sentFiles[0].target.room).toBe("-100");
    expect(adapter.sentFiles[0].out).toEqual({ agent: "re-infra", file, caption: "the diagram" });
  });

  it("hands an agent's file to a tagged peer agent, plus the room copy", async () => {
    const { adapter, url } = await startHub();
    const front = attach(url, "front");
    const kb = attach(url, "kb");
    await waitFor(() => front.registered() && kb.registered());

    front.client.sendFile({ room: "-100", file, caption: "authoring handoff", mentions: ["kb"] });

    // the tagged peer receives the file re-injected into its session
    await waitFor(() => kb.injected.length >= 1);
    expect(kb.injected[0].file).toEqual(file);
    expect(kb.injected[0].message).toMatchObject({
      fromKind: "agent",
      fromId: "front",
      text: "authoring handoff",
    });
    // and the visible copy still posts to the room for the operator
    await waitFor(() => adapter.sentFiles.length >= 1);
    expect(adapter.sentFiles[0].out).toMatchObject({ agent: "front", file });
    // the sender never receives its own file back
    expect(front.injected).toHaveLength(0);
  });

  it("posts an offline notice when a file is handed to an offline peer", async () => {
    const { adapter, url } = await startHub();
    const front = attach(url, "front");
    await waitFor(front.registered);

    front.client.sendFile({ room: "-100", file, mentions: ["ghost"] });
    const notice = await adapter.waitForSent((s) => s.out.kind === "notice");
    expect(notice.out.text).toContain("@ghost");
    // the room still got the file copy
    expect(adapter.sentFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("does not deliver an inbound file to an offline tagged agent", async () => {
    const { adapter, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    await adapter.deliver(humanInbound({ text: "@ghost look", mentions: ["ghost"] }), file);
    const notice = await adapter.waitForSent((s) => s.out.kind === "notice");
    expect(notice.out.text).toContain("@ghost");
    expect(a.injected).toHaveLength(0);
  });
});
