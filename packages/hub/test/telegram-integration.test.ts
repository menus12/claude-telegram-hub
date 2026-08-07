import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundFrame } from "@claude-telegram-hub/protocol";
import { Hub } from "../src/index.js";
import { TelegramAdapter } from "../src/adapters/telegram/adapter.js";
import { FakeTelegramApi } from "./fake-telegram.js";
import { waitFor, delay } from "./helpers.js";

function hubConfig() {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "42", // allowlisted Telegram user id
    HUB_BIND_HOST: "127.0.0.1",
    HUB_BIND_PORT: "0",
    HUB_ADAPTER: "telegram",
    HUB_TAG_SIGIL: "@",
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

let hub: Hub | undefined;
const clients: HubClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  if (hub) await hub.stop();
  hub = undefined;
});

async function startHub(): Promise<{ api: FakeTelegramApi; url: string }> {
  const api = new FakeTelegramApi();
  hub = new Hub({
    config: hubConfig(),
    adapter: new TelegramAdapter({ api, tagSigil: "@" }),
    logger: () => {},
  });
  await hub.start();
  return { api, url: `ws://127.0.0.1:${hub.port()}` };
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

describe("Telegram ↔ hub ↔ channel (mocked Bot API)", () => {
  it("a DM `@agent …` drives the session and the reply returns to the DM", async () => {
    const { api, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    // allowlisted user DMs the bot
    api.push({
      message_id: 10,
      chat: { id: 555, type: "private" },
      from: { id: 42, is_bot: false, username: "alice" },
      text: "@re-infra deploy please",
    });
    await waitFor(() => a.injected.length >= 1);
    expect(a.injected[0].message.text).toBe("@re-infra deploy please");
    const room = a.injected[0].message.room;
    expect(room).toBe("555");

    // the agent replies; it must come back to the DM, attributed
    a.client.sendReply({ room, text: "on it" });
    await waitFor(() => api.sent.length >= 1);
    expect(api.sent[0].chatId).toBe("555");
    expect(api.sent[0].text).toContain("on it"); // MarkdownV2, attributed
    expect(api.sent[0].opts?.parseMode).toBe("MarkdownV2");
  });

  it("drops a DM from a non-allowlisted user", async () => {
    const { api, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    api.push({
      message_id: 11,
      chat: { id: 999, type: "private" },
      from: { id: 777, is_bot: false },
      text: "@re-infra sneaky",
    });
    await delay(50);
    expect(a.injected).toHaveLength(0);
  });

  it("routes a Telegram reply (no @tag) back to the agent that spoke", async () => {
    const { api, url } = await startHub();
    const a = attach(url, "re-infra");
    await waitFor(a.registered);

    // human tags the agent; the agent replies into the DM
    api.push({
      message_id: 30,
      chat: { id: 555, type: "private" },
      from: { id: 42, is_bot: false },
      text: "@re-infra status?",
    });
    await waitFor(() => a.injected.length >= 1);
    a.client.sendReply({ room: "555", text: "all green" });
    await waitFor(() => api.sent.length >= 1);
    const agentMessageId = api.sent[0].messageId;

    // human replies to the agent's message with NO @tag — must still reach the agent
    api.push({
      message_id: 31,
      chat: { id: 555, type: "private" },
      from: { id: 42, is_bot: false },
      text: "and the db?",
      reply_to_message: { message_id: agentMessageId },
    });
    await waitFor(() => a.injected.length >= 2);
    expect(a.injected[1].message.text).toBe("and the db?");
    expect(a.injected[1].message.mentions).toContain("re-infra");
  });

  it("routes a group message to exactly the mentioned agent", async () => {
    const { api, url } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    api.push({
      message_id: 12,
      chat: { id: -100999, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "@re-gitops rollback",
    });
    await waitFor(() => gitops.injected.length >= 1);
    await delay(30);
    expect(gitops.injected).toHaveLength(1);
    expect(infra.injected).toHaveLength(0);
  });
});
