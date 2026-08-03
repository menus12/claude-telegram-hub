import type {
  InboundMessage,
  OutboundMessage,
  RouteTarget,
} from "@claude-telegram-hub/protocol";

/** Called by an adapter to hand a normalized inbound message to the hub. */
export type Inbox = (message: InboundMessage) => Promise<void>;

/**
 * The pluggable transport seam. The hub core is adapter-agnostic: it never
 * imports anything platform-specific. Each transport (telegram, later teams /
 * slack) implements this one interface.
 */
export interface TransportAdapter {
  /** Stable adapter id, e.g. "telegram" | "loopback". */
  readonly name: string;
  /** Begin producing inbound messages into `inbox`. */
  start(inbox: Inbox): Promise<void>;
  /** Deliver an outbound message to a platform target. */
  send(target: RouteTarget, out: OutboundMessage): Promise<void>;
  /** Stop producing messages and release resources. */
  stop(): Promise<void>;
}
