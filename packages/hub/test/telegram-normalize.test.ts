import { describe, it, expect } from "vitest";
import { parseMentions } from "../src/adapters/telegram/mentions.js";
import { toInboundMessage } from "../src/adapters/telegram/normalize.js";
import type { TgMessage } from "../src/adapters/telegram/types.js";

describe("parseMentions", () => {
  it("extracts a single @mention", () => {
    expect(parseMentions("@re-infra ping", "@")).toEqual(["re-infra"]);
  });

  it("extracts and de-duplicates multiple mentions, preserving order", () => {
    expect(parseMentions("@re-infra and @re-gitops and @re-infra", "@")).toEqual([
      "re-infra",
      "re-gitops",
    ]);
  });

  it("does not treat a mid-word sigil (e.g. an email) as a mention", () => {
    expect(parseMentions("mail me at user@re-infra.example", "@")).toEqual([]);
  });

  it("returns [] when there are no mentions", () => {
    expect(parseMentions("just some text", "@")).toEqual([]);
  });

  it("honors a custom sigil", () => {
    expect(parseMentions("hey #re-infra look", "#")).toEqual(["re-infra"]);
    expect(parseMentions("hey @re-infra look", "#")).toEqual([]);
  });
});

describe("toInboundMessage", () => {
  const base: TgMessage = {
    message_id: 7,
    chat: { id: -100123, type: "supergroup" },
    from: { id: 42, is_bot: false, username: "alice" },
    text: "@re-infra deploy please",
  };

  it("normalizes a group text message with mentions", () => {
    const m = toInboundMessage(base, "@");
    expect(m).toEqual({
      adapter: "telegram",
      room: "-100123",
      fromKind: "human",
      fromId: "42",
      text: "@re-infra deploy please",
      mentions: ["re-infra"],
    });
  });

  it("normalizes a DM the same way (room is the private chat id)", () => {
    const dm: TgMessage = {
      message_id: 1,
      chat: { id: 555, type: "private" },
      from: { id: 42, is_bot: false },
      text: "@re-infra status?",
    };
    const m = toInboundMessage(dm, "@");
    expect(m?.room).toBe("555");
    expect(m?.mentions).toEqual(["re-infra"]);
  });

  it("drops messages from bots", () => {
    expect(
      toInboundMessage({ ...base, from: { id: 99, is_bot: true } }, "@"),
    ).toBeNull();
  });

  it("drops messages with no text or no sender", () => {
    expect(toInboundMessage({ ...base, text: undefined }, "@")).toBeNull();
    expect(toInboundMessage({ ...base, from: undefined }, "@")).toBeNull();
  });

  it("resolves a reply_to_message to an agent mention (no @tag needed)", () => {
    const reply: TgMessage = {
      message_id: 8,
      chat: { id: -100123, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text: "ship it",
      reply_to_message: { message_id: 7 },
    };
    const m = toInboundMessage(reply, "@", (room, id) =>
      room === "-100123" && id === 7 ? "re-infra" : undefined,
    );
    expect(m?.mentions).toEqual(["re-infra"]);
  });

  it("composes a reply target with an explicit @tag, de-duplicating", () => {
    const reply: TgMessage = {
      ...base,
      text: "@re-gitops and you", // explicit tag
      reply_to_message: { message_id: 7 },
    };
    const m = toInboundMessage(reply, "@", () => "re-infra"); // reply target
    expect(m?.mentions).toEqual(["re-gitops", "re-infra"]);
  });

  it("does not double-add when the reply target is already @tagged", () => {
    const reply: TgMessage = {
      ...base,
      text: "@re-infra ping",
      reply_to_message: { message_id: 7 },
    };
    const m = toInboundMessage(reply, "@", () => "re-infra");
    expect(m?.mentions).toEqual(["re-infra"]);
  });

  it("ignores a reply whose target isn't a known agent message", () => {
    const reply: TgMessage = {
      ...base,
      text: "just replying",
      reply_to_message: { message_id: 999 },
    };
    const m = toInboundMessage(reply, "@", () => undefined);
    expect(m?.mentions).toEqual([]);
  });
});
