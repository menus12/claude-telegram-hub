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

// A voice note as the Telegram adapter will produce it: text = transcript, voice: true.
function voiceNote(text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: "loopback",
    room: "-100",
    fromKind: "human",
    fromId: "user1",
    text,
    mentions: [],
    voice: true,
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

const enabled = { HUB_STT_URL: "http://stt:8000" };
const echoText = (a: LoopbackAdapter) => a.sent.find((s) => s.out.text.includes("heard"))?.out.text;

describe("voice addressing", () => {
  it("routes a voice note by its leading spoken name and echoes the transcript", async () => {
    const { adapter, url } = await startHub(enabled);
    const platform = attach(url, "platform");
    await waitFor(platform.registered);

    await adapter.deliver(voiceNote("platform, redeploy the service"));
    await waitFor(() => platform.injected.length >= 1);
    expect(platform.injected[0].message.text).toBe("platform, redeploy the service");
    expect(echoText(adapter)).toContain("@platform");
  });

  it("honors a reply-to address without re-parsing spoken names", async () => {
    const { adapter, url } = await startHub(enabled);
    const platform = attach(url, "platform");
    await waitFor(platform.registered);

    // reply-to already resolved to platform; the words are the message
    await adapter.deliver(voiceNote("and what about the database", { mentions: ["platform"] }));
    await waitFor(() => platform.injected.length >= 1);
    expect(echoText(adapter)).toContain("@platform");
  });

  it("broadcasts a voice note that opens with everyone", async () => {
    const { adapter, url } = await startHub(enabled);
    const platform = attach(url, "platform");
    const infra = attach(url, "re-infra");
    await waitFor(() => platform.registered() && infra.registered());

    await adapter.deliver(voiceNote("everyone stand down"));
    await waitFor(() => platform.injected.length >= 1 && infra.injected.length >= 1);
  });

  it("nudges when it can't tell who a voice note is for", async () => {
    const { adapter, url } = await startHub(enabled);
    const platform = attach(url, "platform");
    await waitFor(platform.registered);

    await adapter.deliver(voiceNote("can you redeploy the service"));
    const notice = await adapter.waitForSent((s) => s.out.text.includes("couldn't tell who"));
    expect(notice.out.kind).toBe("notice");
    await delay(20);
    expect(platform.injected).toHaveLength(0);
  });

  it("posts an unclear notice for an empty transcript", async () => {
    const { adapter } = await startHub(enabled);
    await adapter.deliver(voiceNote("   "));
    const notice = await adapter.waitForSent((s) => s.out.text.includes("couldn't make out"));
    expect(notice.out.kind).toBe("notice");
  });

  it("tells the operator voice isn't enabled when no STT is configured", async () => {
    const { adapter, url } = await startHub(); // no HUB_STT_URL
    const platform = attach(url, "platform");
    await waitFor(platform.registered);

    await adapter.deliver(voiceNote("platform redeploy"));
    const notice = await adapter.waitForSent((s) => s.out.text.includes("aren't enabled"));
    expect(notice.out.kind).toBe("notice");
    await delay(20);
    expect(platform.injected).toHaveLength(0);
  });
});
