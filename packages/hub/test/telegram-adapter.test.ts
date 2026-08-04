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

  it("stops the underlying api", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.start(() => Promise.resolve());
    await adapter.stop();
    expect(api.started).toBe(false);
  });
});
