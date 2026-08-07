import { describe, it, expect } from "vitest";
import type { InboundMessage } from "@claude-telegram-hub/protocol";
import { TelegramAdapter } from "../src/adapters/telegram/adapter.js";
import { FakeTelegramApi } from "./fake-telegram.js";
import { delay } from "./helpers.js";

describe("TelegramAdapter", () => {
  it("starts polling and normalizes inbound to the hub", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });
    expect(api.started).toBe(true);

    api.push({
      message_id: 1,
      chat: { id: 555, type: "private" },
      from: { id: 42, is_bot: false },
      text: "@re-infra hi",
    });
    await delay(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      room: "555",
      fromId: "42",
      mentions: ["re-infra"],
    });
  });

  it("ignores non-routable messages (bot sender)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });
    api.push({
      message_id: 1,
      chat: { id: 1, type: "private" },
      from: { id: 2, is_bot: true },
      text: "hi",
    });
    await delay(0);
    expect(received).toHaveLength(0);
  });

  it("renders a reply as MarkdownV2 with the bold agent prefix + reply target", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.send(
      { adapter: "telegram", room: "555", replyToId: "7" },
      { agent: "re-infra", text: "done", kind: "reply" },
    );
    expect(api.sent[0]).toEqual({
      chatId: "555",
      text: "*re\\-infra* ▸ done\n", // agent bold, hyphen escaped for MarkdownV2
      opts: { replyToMessageId: 7, parseMode: "MarkdownV2" },
      messageId: 1000,
    });
  });

  it("converts CommonMark (bold / code / lists) to MarkdownV2", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.send(
      { adapter: "telegram", room: "r" },
      { agent: "re-infra", text: "some **bold**, `code`, and\n- a\n- b", kind: "reply" },
    );
    const sent = api.sent[0];
    expect(sent.opts?.parseMode).toBe("MarkdownV2");
    expect(sent.text).toContain("*bold*"); // ** -> *
    expect(sent.text).toContain("`code`");
    expect(sent.text).toContain("•   a"); // list item -> bullet
  });

  it("sends a hub notice as MarkdownV2, without attribution", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.send(
      { adapter: "telegram", room: "555" },
      { agent: "hub", text: "paused", kind: "notice" },
    );
    expect(api.sent[0]).toEqual({
      chatId: "555",
      text: "paused\n",
      opts: { parseMode: "MarkdownV2" },
      messageId: 1000,
    });
  });

  it("falls back to plain text when Telegram rejects the entities", async () => {
    const api = new FakeTelegramApi();
    api.failNext(new Error("Bad Request: can't parse entities in message"));
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.send(
      { adapter: "telegram", room: "555", replyToId: "7" },
      { agent: "re-infra", text: "**x**", kind: "reply" },
    );
    // one delivery: the plain-text retry (attributed, no parse mode)
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0].text).toBe("re-infra ▸ **x**");
    expect(api.sent[0].opts?.parseMode).toBeUndefined();
    expect(api.sent[0].opts?.replyToMessageId).toBe(7);
  });

  it("propagates non-parse send errors (no plain retry)", async () => {
    const api = new FakeTelegramApi();
    api.failNext(new Error("Bad Request: chat not found"));
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await expect(
      adapter.send({ adapter: "telegram", room: "x" }, { agent: "a", text: "hi", kind: "reply" }),
    ).rejects.toThrow(/chat not found/);
    expect(api.sent).toHaveLength(0);
  });

  it("routes a Telegram reply to an agent's message back to that agent", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });

    // the agent sends a reply into the room; the adapter indexes its message_id
    await adapter.send(
      { adapter: "telegram", room: "-100999" },
      { agent: "re-infra", text: "deployed", kind: "reply" },
    );
    const sentId = api.sent[0].messageId;

    // a human replies to that message with no @tag
    api.push({
      message_id: 20,
      chat: { id: -100999, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "thanks, roll it back",
      reply_to_message: { message_id: sentId },
    });
    await delay(0);

    expect(received).toHaveLength(1);
    expect(received[0].mentions).toEqual(["re-infra"]);
  });

  it("routes a reply via the attribution prefix when the index misses (survives restart)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });

    // Nothing recorded (as after a hub restart). The replied-to message's visible
    // text carries the `agent ▸ …` attribution, which identifies the author.
    api.push({
      message_id: 30,
      chat: { id: -100999, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "roll it back",
      reply_to_message: { message_id: 5, text: "re-infra ▸ deployed to prod" },
    });
    await delay(0);
    expect(received).toHaveLength(1);
    expect(received[0].mentions).toEqual(["re-infra"]);
  });

  it("does not resolve a reply to an unattributed message (e.g. a hub notice)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });
    api.push({
      message_id: 31,
      chat: { id: -100999, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "replying to a notice",
      reply_to_message: { message_id: 6, text: "@re-infra is online." },
    });
    await delay(0);
    expect(received[0].mentions).toEqual([]);
  });

  it("does not index hub notices (a reply to one resolves to nobody)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });

    await adapter.send(
      { adapter: "telegram", room: "-100999" },
      { agent: "hub", text: "paused", kind: "notice" },
    );
    const noticeId = api.sent[0].messageId;

    api.push({
      message_id: 21,
      chat: { id: -100999, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "replying to the notice",
      reply_to_message: { message_id: noticeId },
    });
    await delay(0);

    expect(received[0].mentions).toEqual([]);
  });

  it("stops the underlying api", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.start(() => Promise.resolve());
    await adapter.stop();
    expect(api.started).toBe(false);
  });
});
