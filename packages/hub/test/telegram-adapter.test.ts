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

  it("sends a voiced reply as a Telegram voice note with an attributed caption", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.sendVoice(
      { adapter: "telegram", room: "-100" },
      { agent: "platform", audio: Buffer.from("OGG"), mimeType: "audio/ogg", text: "all green" },
    );
    expect(api.sentFiles[0]).toMatchObject({ kind: "voice", chatId: "-100", filename: "reply.ogg" });
    expect(api.sentFiles[0].opts?.caption).toBe("platform ▸ all green");
    expect(api.sentFiles[0].bytes.toString()).toBe("OGG");
  });

  it("truncates a voice-note caption over Telegram's 1024-char limit (#94)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    const longText = "x".repeat(2000);
    await adapter.sendVoice(
      { adapter: "telegram", room: "-100" },
      { agent: "platform", audio: Buffer.from("OGG"), mimeType: "audio/ogg", text: longText },
    );
    const caption = api.sentFiles[0].opts?.caption ?? "";
    expect(caption.length).toBeLessThanOrEqual(1024); // no "caption is too long" 400
    expect(caption.startsWith("platform ▸ ")).toBe(true); // attribution kept
    expect(caption.endsWith("…")).toBe(true); // body truncated with an ellipsis
  });

  it("keeps the operator @mention whole when truncating a long caption (#94)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.sendVoice(
      { adapter: "telegram", room: "-100" },
      { agent: "infra", audio: Buffer.from("OGG"), mimeType: "audio/ogg", text: "y".repeat(2000), mentionUsernames: ["a_gorbachev"] },
    );
    const caption = api.sentFiles[0].opts?.caption ?? "";
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).toContain("@a_gorbachev"); // the mention survives truncation
  });

  it("indexes a voiced reply so a reply to it routes back to the agent", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });
    await adapter.sendVoice(
      { adapter: "telegram", room: "-100" },
      { agent: "platform", audio: Buffer.from("OGG"), mimeType: "audio/ogg", text: "all green" },
    );
    const voiceId = api.sentFiles[0].messageId;
    api.push({
      message_id: 50,
      chat: { id: -100, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "and staging?",
      reply_to_message: { message_id: voiceId },
    });
    await delay(0);
    expect(received[0].mentions).toEqual(["platform"]);
  });

  it("stops the underlying api", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.start(() => Promise.resolve());
    await adapter.stop();
    expect(api.started).toBe(false);
  });

  it("renders an @operator mention as a real mention link and replies to the operator's last message (#94)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.start(() => Promise.resolve());
    // the operator posts (message_id 7) → becomes the mute-breaking reply target
    api.push({ message_id: 7, chat: { id: 555, type: "private" }, from: { id: 42, is_bot: false }, text: "@infra status?" });
    await delay(0);

    await adapter.send(
      { adapter: "telegram", room: "555" },
      { agent: "infra", text: "blocked, need your call", kind: "reply", mentionUserIds: ["42"] },
    );
    const sent = api.sent.at(-1)!;
    expect(sent.text).toContain("[👤 operator](tg://user?id=42)"); // real mention link
    expect(sent.opts?.replyToMessageId).toBe(7); // replies to the operator's last message

    // a normal reply carries neither the mention nor an auto reply-to
    await adapter.send({ adapter: "telegram", room: "555" }, { agent: "infra", text: "done", kind: "reply" });
    const plain = api.sent.at(-1)!;
    expect(plain.text).not.toContain("tg://user");
    expect(plain.opts?.replyToMessageId).toBeUndefined();
  });

  it("renders @operator as a real @username mention when configured, not an id-link (#94)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.start(() => Promise.resolve());
    api.push({ message_id: 7, chat: { id: 555, type: "private" }, from: { id: 42, is_bot: false }, text: "@infra status?" });
    await delay(0);

    await adapter.send(
      { adapter: "telegram", room: "555" },
      { agent: "infra", text: "blocked, need your call", kind: "reply", mentionUserIds: ["42"], mentionUsernames: ["a_gorbachev"] },
    );
    const sent = api.sent.at(-1)!;
    // real @username (underscore escaped for MarkdownV2) — this is what trips the
    // muted-chat mention exception; the id-link is NOT used when a username is known.
    expect(sent.text).toContain("@a\\_gorbachev");
    expect(sent.text).not.toContain("tg://user");
    expect(sent.opts?.replyToMessageId).toBe(7); // still replies to the operator's last message
  });

  it("keeps the plain @username mention when MarkdownV2 parsing fails (#94)", async () => {
    const api = new FakeTelegramApi();
    api.failNext(new Error("Bad Request: can't parse entities in message"));
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.send(
      { adapter: "telegram", room: "555" },
      { agent: "infra", text: "**x**", kind: "reply", mentionUsernames: ["a_gorbachev"] },
    );
    // the plain-text retry keeps a raw @username (unescaped) so the mention still fires
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0].text).toContain("@a_gorbachev");
    expect(api.sent[0].opts?.parseMode).toBeUndefined();
  });

  it("carries the operator @username into a voiced reply's caption (#94)", async () => {
    const api = new FakeTelegramApi();
    const adapter = new TelegramAdapter({ api, tagSigil: "@" });
    await adapter.start(() => Promise.resolve());
    api.push({ message_id: 9, chat: { id: -100, type: "supergroup" }, from: { id: 42, is_bot: false }, text: "@infra?" });
    await delay(0);
    await adapter.sendVoice(
      { adapter: "telegram", room: "-100" },
      { agent: "infra", audio: Buffer.from("OGG"), mimeType: "audio/ogg", text: "need your call", mentionUsernames: ["a_gorbachev"] },
    );
    // caption (plain text) carries the @username mention + replies to the operator's msg
    expect(api.sentFiles[0].opts?.caption).toContain("@a_gorbachev");
    expect(api.sentFiles[0].opts?.replyToMessageId).toBe(9);
  });
});
