import {
  loopFrozenNotice,
  offlineTargetNotice,
  slaEscalationNotice,
} from "@claude-telegram-hub/protocol";
import type {
  HubConfig,
  InboundMessage,
  OutboundMessage,
  ReplyFrame,
  RouteTarget,
} from "@claude-telegram-hub/protocol";
import type { TransportAdapter } from "./adapter.js";
import { AgentRegistry } from "./registry.js";
import { LoopGovernor } from "./governor.js";
import { PresenceTracker } from "./presence.js";
import { ResponseSla, type PendingAsk } from "./response-sla.js";
import type { Scheduler } from "./scheduler.js";
import { SessionServer } from "./server.js";
import type { Logger } from "./logger.js";

export interface HubDeps {
  config: HubConfig;
  adapter: TransportAdapter;
  logger: Logger;
  /** Injectable timer for time-based backstops (presence, SLA); tests supply a fake. */
  scheduler?: Scheduler;
}

/** Trim an asking message to a short quotable snippet for reminders/escalations. */
function quote(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The always-on hub core. Owns the agent registry and the session server, and
 * wires the (single) transport adapter to routing:
 *
 *   adapter inbound → allowlist → deliver to every explicitly-mentioned agent
 *   session reply   → post a human-visible copy to the room, and re-inject the
 *                     hop into any tagged peer agents (agent↔agent)
 *   tagged but offline → an in-room notice, never a silent drop
 *
 * Adapter-agnostic: it knows only the `TransportAdapter` interface. The loop
 * governor that bounds agent↔agent chains arrives in Stage 5.
 */
export class Hub {
  private readonly registry = new AgentRegistry();
  private readonly server: SessionServer;
  private readonly allowlist: Set<string>;
  private readonly governor: LoopGovernor;
  private readonly presence: PresenceTracker | undefined;
  private readonly sla: ResponseSla | undefined;
  private started = false;

  constructor(private readonly deps: HubDeps) {
    this.allowlist = new Set(deps.config.allowlist);
    this.governor = new LoopGovernor(deps.config.hopBudget);
    this.sla = deps.config.sla
      ? new ResponseSla({
          ackSlaMs: deps.config.ackSlaMs,
          answerSlaMs: deps.config.answerSlaMs,
          nudge: (ask) => this.nudgePeer(ask),
          escalate: (ask) => this.escalateAsk(ask),
          ...(deps.scheduler ? { schedule: deps.scheduler } : {}),
        })
      : undefined;
    // Presence announcements are opt-in and only meaningful where there's a room
    // to post them to; otherwise the tracker is absent and lifecycle hooks no-op.
    this.presence =
      deps.config.presence && deps.config.rooms.length > 0
        ? new PresenceTracker({
            graceMs: deps.config.presenceGraceMs,
            isLive: (agent) => this.registry.has(agent),
            emit: (notice) => this.postToRooms(notice),
          })
        : undefined;
    this.server = new SessionServer({
      host: deps.config.bindHost,
      port: deps.config.bindPort,
      sessionSecret: deps.config.sessionSecret,
      registry: this.registry,
      onReply: (agent, reply) => this.onReply(agent, reply),
      onRegister: (agent) => this.presence?.onConnect(agent),
      onDetach: (agent) => this.presence?.onDetach(agent),
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
    this.presence?.stop();
    this.sla?.stop();
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

  /**
   * SLA T1: re-inject a one-line reminder into the silent peer's session. This is
   * a hub follow-up, not an agent→agent hop, so it bypasses the loop governor. If
   * the peer has since gone offline there's nothing to inject; T2 still escalates.
   */
  private nudgePeer(ask: PendingAsk): void {
    const session = this.registry.get(ask.to);
    if (!session) return;
    session.send({
      type: "inbound",
      message: {
        adapter: this.deps.adapter.name,
        room: ask.room,
        fromKind: "agent",
        fromId: ask.from,
        text: `reminder: @${ask.from} is still waiting on your reply to "${quote(ask.text)}" — ack (an ETA) or answer.`,
        mentions: [ask.to],
      },
    });
  }

  /**
   * SLA T2: escalate an unanswered ask to the operator in the room, and (best
   * effort) unblock the asker if its session is still alive. Both are hub-generated
   * and governor-neutral.
   */
  private escalateAsk(ask: PendingAsk): void {
    const minutes = Math.round(this.deps.config.answerSlaMs / 60000);
    void this.deps.adapter
      .send(
        { adapter: this.deps.adapter.name, room: ask.room },
        slaEscalationNotice(ask.from, ask.to, minutes),
      )
      .catch((err: unknown) => {
        this.deps.logger("warn", "sla escalation send failed", { error: String(err) });
      });

    const asker = this.registry.get(ask.from);
    if (asker) {
      asker.send({
        type: "inbound",
        message: {
          adapter: this.deps.adapter.name,
          room: ask.room,
          fromKind: "agent",
          fromId: "hub",
          text: `no response from @${ask.to} after ${minutes} min on "${quote(ask.text)}". Proceed on a fallback or hand it to the operator.`,
          mentions: [ask.from],
        },
      });
    }
  }

  /** Post a hub-generated notice (e.g. presence) to every configured room. */
  private postToRooms(notice: OutboundMessage): void {
    for (const room of this.deps.config.rooms) {
      void this.deps.adapter
        .send({ adapter: this.deps.adapter.name, room }, notice)
        .catch((err: unknown) => {
          this.deps.logger("warn", "presence notice send failed", {
            room,
            error: String(err),
          });
        });
    }
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

    // Any human message refills the room's coordination thread (human presence =
    // license to continue), unfreezing agent↔agent routing there.
    this.governor.refill(message.room);

    // Explicit-mention-only routing: untagged chatter is not injected.
    if (message.mentions.length === 0) {
      this.deps.logger("debug", "no mentions; not routing", { room: message.room });
      return;
    }

    // Human→agent delivery is never frozen — only agent→agent hops are bounded.
    await this.routeToMentioned(message);
  }

  /** hub → adapter: a session's reply. */
  private onReply(agent: string, reply: ReplyFrame): void {
    // 0) The speaker just produced a reply → satisfy any SLA ask that was waiting
    // on it in this room (an ETA ack and a full answer both count as "spoke").
    this.sla?.onAgentSpoke(reply.room, agent);

    // 1) Post a human-visible copy to the room, attributed to the speaker.
    const out: OutboundMessage = { agent, text: reply.text, kind: "reply" };
    const target: RouteTarget = {
      adapter: this.deps.adapter.name,
      room: reply.room,
      ...(reply.replyToId ? { replyToId: reply.replyToId } : {}),
    };
    void this.deps.adapter.send(target, out).catch((err: unknown) => {
      this.deps.logger("warn", "adapter send failed", { error: String(err) });
    });

    // 2) Agent↔agent: re-inject the hop into any tagged peer agents, bounded by
    // the loop governor. The platform never delivers bot→bot, so the hub carries
    // it; the human already sees the visible copy posted above.
    const peers = reply.mentions.filter((m) => m !== agent);
    if (peers.length > 0) {
      const decision = this.governor.onAgentHop(reply.room);
      if (!decision.allowed) {
        this.deps.logger("info", "agent↔agent routing frozen; hop dropped", {
          room: reply.room,
          from: agent,
        });
        return;
      }
      const reinjected: InboundMessage = {
        adapter: this.deps.adapter.name,
        room: reply.room,
        fromKind: "agent",
        fromId: agent,
        text: reply.text,
        mentions: reply.mentions,
      };
      void this.routeToMentioned(reinjected).catch((err: unknown) => {
        this.deps.logger("warn", "re-injection failed", { error: String(err) });
      });
      // Watch each delivered ask (peer online) for a response. Offline peers
      // already got an immediate in-room notice, so there's nothing to wait on.
      for (const peer of peers) {
        if (this.registry.has(peer)) {
          this.sla?.openAsk({ room: reply.room, from: agent, to: peer, text: reply.text });
        }
      }
      if (decision.froze) {
        this.deps.logger("info", "hop budget exhausted; freezing thread", {
          room: reply.room,
        });
        void this.deps.adapter
          .send({ adapter: this.deps.adapter.name, room: reply.room }, loopFrozenNotice())
          .catch((err: unknown) => {
            this.deps.logger("warn", "adapter send failed", { error: String(err) });
          });
      }
    }
  }

  /**
   * Deliver a message to every agent it mentions: inject into connected
   * sessions, and post an in-room offline notice for any tagged agent without a
   * live session. An agent never re-injects into itself (self-tag is skipped).
   */
  private async routeToMentioned(message: InboundMessage): Promise<void> {
    for (const agent of message.mentions) {
      if (message.fromKind === "agent" && agent === message.fromId) continue;
      const session = this.registry.get(agent);
      if (!session) {
        this.deps.logger("info", "tagged agent has no live session", { agent });
        await this.deps.adapter.send(
          { adapter: message.adapter, room: message.room },
          offlineTargetNotice(agent),
        );
        continue;
      }
      session.send({ type: "inbound", message });
      this.deps.logger("debug", "injected inbound", {
        agent,
        room: message.room,
        fromKind: message.fromKind,
      });
    }
  }
}
