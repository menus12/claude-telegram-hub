/**
 * Bounded index of `room:message_id → agent` for the messages the bot has sent.
 * It lets a Telegram *reply* to an agent's message route back to that agent, the
 * same as an explicit `@tag`: the adapter records every agent reply it sends here,
 * and resolves an inbound `reply_to_message` against it.
 *
 * The bot posts every agent's messages, so an inbound reply's `from` is always the
 * bot — this index is the only source of truth for which agent authored the message
 * being replied to. Message ids are per-chat, not global, so entries are keyed by
 * `room` + `message_id`.
 *
 * Bounded two ways so it can't grow without limit on a long-lived hub: by entry
 * count (oldest evicted first — Map preserves insertion order) and by age (`ttlMs`).
 * The clock is injectable so tests are deterministic.
 */
export interface ReplyIndexOptions {
  /** Maximum entries retained; oldest evicted past this. Default 2000. */
  maxEntries?: number;
  /** Entry lifetime; a reply older than this no longer resolves. Default 24h. */
  ttlMs?: number;
  /** Time source (ms); injectable for tests. Default `Date.now`. */
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class ReplyIndex {
  private readonly entries = new Map<string, { agent: string; at: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: ReplyIndexOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 2000;
    this.ttlMs = opts.ttlMs ?? DAY_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  private static key(room: string, messageId: number): string {
    return `${room}:${messageId}`;
  }

  /** Remember that `agent` authored `messageId` in `room`. */
  record(room: string, messageId: number, agent: string): void {
    const key = ReplyIndex.key(room, messageId);
    // Re-insert so this key becomes the most-recently-added (Map iteration order).
    this.entries.delete(key);
    this.entries.set(key, { agent, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The agent who authored `messageId` in `room`, or `undefined` if unknown/expired. */
  resolve(room: string, messageId: number): string | undefined {
    const key = ReplyIndex.key(room, messageId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.agent;
  }
}
