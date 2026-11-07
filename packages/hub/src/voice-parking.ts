/**
 * Unaddressed voice transcripts, parked so the sender can still deliver them (#109).
 *
 * A voice note the hub can't address (no reply-to, no spoken name, no forward
 * comment) used to be discarded after a notice. Now its transcript is parked per
 * (room, sender) for a short window; a bare `@agent` message from the same sender
 * in that room claims it. One slot per (room, sender) — the newest note wins —
 * so the store is bounded by the number of active senders.
 */
export interface ParkedTranscript {
  text: string;
  at: number;
}

export class VoiceParking {
  private readonly slots = new Map<string, ParkedTranscript>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Park `text` for (room, sender), replacing any earlier note. */
  park(room: string, sender: string, text: string): void {
    this.prune();
    this.slots.set(key(room, sender), { text, at: this.now() });
  }

  /** Take (and remove) the sender's parked transcript if it is still fresh. */
  claim(room: string, sender: string): ParkedTranscript | undefined {
    const k = key(room, sender);
    const slot = this.slots.get(k);
    if (!slot) return undefined;
    this.slots.delete(k);
    return this.now() - slot.at <= this.ttlMs ? slot : undefined;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, slot] of this.slots) if (slot.at < cutoff) this.slots.delete(k);
  }
}

function key(room: string, sender: string): string {
  return `${room}\u0000${sender}`;
}

/**
 * True when `text` is nothing but `@name` tags (and whitespace/punctuation) — the
 * shape of a claim for a parked transcript. A message with any other words is an
 * ordinary message and is routed as one.
 */
export function isBareMentions(text: string, sigil: string): boolean {
  const escaped = sigil.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rest = text.replace(new RegExp(`${escaped}[A-Za-z0-9_-]+`, "g"), "");
  return /^[\s,.;:!?—-]*$/.test(rest) && rest.length < text.length;
}
