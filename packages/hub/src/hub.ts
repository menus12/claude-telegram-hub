import type {
  HubConfig,
  InboundFrame,
  InboundMessage,
  OutboundMessage,
  ReplyFrame,
  RouteTarget,
} from "@claude-telegram-hub/protocol";
import type { TransportAdapter } from "./adapter.js";
import { AgentRegistry } from "./registry.js";
import { SessionServer } from "./server.js";
import type { Logger } from "./logger.js";

export interface HubDeps {
  config: HubConfig;
  adapter: TransportAdapter;
  logger: Logger;
}

/**
 * The always-on hub core. Owns the agent registry and the session server, and
 * wires the (single) transport adapter to routing:
 *
 *   adapter inbound → allowlist → deliver to explicitly-mentioned agents
 *   session reply   → adapter.send back to the originating room
 *
 * Adapter-agnostic: it knows only the `TransportAdapter` interface. Group
 * routing, agent↔agent re-injection, and the loop governor arrive in later
 * stages; this stage does explicit-mention delivery for one adapter.
 */
export class Hub {
  private readonly registry = new AgentRegistry();
  private readonly server: SessionServer;
  private readonly allowlist: Set<string>;
  private started = false;

  constructor(private readonly deps: HubDeps) {
    this.allowlist = new Set(deps.config.allowlist);
    this.server = new SessionServer({
      host: deps.config.bindHost,
      port: deps.config.bindPort,
      sessionSecret: deps.config.sessionSecret,
      registry: this.registry,
      onReply: (agent, reply) => this.onReply(agent, reply),
      isReady: () => this.started,
      logger: deps.logger,
    });
  }

  async start(): Promise<void> {
    await this.server.listen();
    await this.deps.adapter.start((m) => this.onInbound(m));
    this.started = true;
    this.deps.logger("info", "hub started", { adapter: this.deps.adapter.name });
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.deps.adapter.stop();
    await this.server.close();
    this.deps.logger("info", "hub stopped");
  }

  /** The bound session-server port (useful with an ephemeral port in tests). */
  port(): number {
    return this.server.port();
  }

  /** Agent names with a live session right now. */
  connectedAgents(): string[] {
    return this.registry.list();
  }

  /** adapter → hub: a normalized platform inbound message. */
  private async onInbound(message: InboundMessage): Promise<void> {
    // Allowlist applies to real senders; agent-origin traffic is hub-internal.
    if (message.fromKind === "human" && !this.allowlist.has(message.fromId)) {
      this.deps.logger("warn", "dropping non-allowlisted sender", {
        fromId: message.fromId,
      });
      return;
    }

    // Explicit-mention-only routing: untagged chatter is not injected.
    if (message.mentions.length === 0) {
      this.deps.logger("debug", "no mentions; not routing", { room: message.room });
      return;
    }

    for (const agent of message.mentions) {
      const session = this.registry.get(agent);
      if (!session) {
        // Offline-target reporting to the room lands in Stage 4; log for now.
        this.deps.logger("info", "tagged agent has no live session", { agent });
        continue;
      }
      const frame: InboundFrame = { type: "inbound", message };
      session.send(frame);
      this.deps.logger("debug", "injected inbound", { agent, room: message.room });
    }
  }

  /** hub → adapter: a session's reply, delivered back to the originating room. */
  private onReply(agent: string, reply: ReplyFrame): void {
    const out: OutboundMessage = { agent, text: reply.text, kind: "reply" };
    const target: RouteTarget = {
      adapter: this.deps.adapter.name,
      room: reply.room,
      ...(reply.replyToId ? { replyToId: reply.replyToId } : {}),
    };
    void this.deps.adapter.send(target, out).catch((err: unknown) => {
      this.deps.logger("warn", "adapter send failed", { error: String(err) });
    });
    // Agent→agent re-injection (reply.mentions) is Stage 4.
  }
}
