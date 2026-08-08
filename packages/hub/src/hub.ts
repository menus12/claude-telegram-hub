import {
  duplicateRegistrationNotice,
  loopFrozenNotice,
  offlineTargetNotice,
  slaEscalationNotice,
  transcriptEchoNotice,
  voiceDisabledNotice,
  voiceUnaddressedNotice,
  voiceUnclearNotice,
} from "@claude-telegram-hub/protocol";
import { isBroadcastMention, speakableText } from "@claude-telegram-hub/protocol";
import { resolveSpokenRecipients } from "./voice-routing.js";
import type {
  FilePayload,
  HubConfig,
  InboundMessage,
  OutboundMessage,
  ReplyFrame,
  RouteTarget,
  SendFileFrame,
} from "@claude-telegram-hub/protocol";
import type { TransportAdapter } from "./adapter.js";
import { AccessController, KNOWN_COMMANDS, parseCommand, type ParsedCommand } from "./access.js";
import { AgentRegistry } from "./registry.js";
import { LoopGovernor } from "./governor.js";
import { PresenceTracker } from "./presence.js";
import { ResponseSla, type PendingAsk } from "./response-sla.js";
import type { Scheduler } from "./scheduler.js";
import { SessionServer } from "./server.js";
import type { SynthesisService } from "./synthesis.js";
import type { Logger } from "./logger.js";

export interface HubDeps {
  config: HubConfig;
  adapter: TransportAdapter;
  logger: Logger;
  /** Injectable timer for time-based backstops (presence, SLA); tests supply a fake. */
  scheduler?: Scheduler;
  /** Text-to-speech for voiced replies; absent → agents can't reply with voice. */
  synth?: SynthesisService;
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
  private readonly access: AccessController;
  private readonly pairing: boolean;
  private readonly notifyTarget: "dm" | "rooms" | "both";
  private readonly broadcast: boolean;
  private readonly voiceEnabled: boolean;
  private readonly voiceEcho: boolean;
  private readonly synth: SynthesisService | undefined;
  private readonly ttsMaxChars: number;
  private readonly governor: LoopGovernor;
  private readonly presence: PresenceTracker | undefined;
  private readonly sla: ResponseSla | undefined;
  private started = false;

  constructor(private readonly deps: HubDeps) {
    // Admins default to the allowlist seed when none are configured explicitly.
    const admins =
      deps.config.admins.length > 0 ? deps.config.admins : deps.config.allowlist;
    this.access = new AccessController({
      seed: deps.config.allowlist,
      admins,
      ...(deps.config.stateFile ? { stateFile: deps.config.stateFile } : {}),
      logger: deps.logger,
    });
    this.pairing = deps.config.pairing;
    this.notifyTarget = deps.config.notify;
    this.broadcast = deps.config.broadcast;
    this.voiceEnabled = deps.config.sttUrl !== undefined;
    this.voiceEcho = deps.config.voiceEcho;
    this.synth = deps.synth;
    this.ttsMaxChars = deps.config.ttsMaxChars;
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
    // Presence is opt-in; delivery goes through notify() (admin DMs and/or rooms),
    // so it works even with no group configured.
    this.presence = deps.config.presence
      ? new PresenceTracker({
          graceMs: deps.config.presenceGraceMs,
          isLive: (agent) => this.registry.has(agent),
          emit: (notice) => this.notify(notice),
        })
      : undefined;
    this.server = new SessionServer({
      host: deps.config.bindHost,
      port: deps.config.bindPort,
      sessionSecret: deps.config.sessionSecret,
      registry: this.registry,
      onReply: (agent, reply) => this.onReply(agent, reply),
      onSendFile: (agent, frame) => this.onSendFile(agent, frame),
      onRegister: (agent) => this.presence?.onConnect(agent),
      onDetach: (agent) => this.presence?.onDetach(agent),
      onDuplicateRejected: (agent) => this.notify(duplicateRegistrationNotice(agent)),
      duplicateName: deps.config.duplicateName,
      keepaliveMs: deps.config.keepaliveMs,
      // Advertise voice-reply capability so the channel can tell a sending agent
      // when its voice:true reply won't be voiced (too long / unspeakable) (#74).
      voiceReply: { enabled: this.synth !== undefined, maxChars: this.ttsMaxChars },
      isReady: () => this.started,
      logger: deps.logger,
    });
  }

  async start(): Promise<void> {
    await this.server.listen();
    await this.deps.adapter.start((m, f) => this.onInbound(m, f));
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

  /** Send a hub notice into a single room/DM (a command reply or admin ping). */
  private replyNotice(room: string, text: string): void {
    void this.deps.adapter
      .send({ adapter: this.deps.adapter.name, room }, { agent: "hub", text, kind: "notice" })
      .catch((err: unknown) => {
        this.deps.logger("warn", "notice send failed", { room, error: String(err) });
      });
  }

  /** DM every admin (admin id doubles as their DM room on Telegram). */
  private notifyAdmins(text: string): void {
    for (const adminId of this.access.adminIds()) this.replyNotice(adminId, text);
  }

  /** Handle a known in-chat allowlist command from a human. */
  private handleCommand(message: InboundMessage, cmd: ParsedCommand): void {
    const { fromId, room } = message;

    if (cmd.name === "start") {
      if (this.access.isAllowed(fromId)) {
        this.replyNotice(room, `You're authorized (id ${fromId}). Send @<agent> <message>.`);
      } else {
        this.handleUnauthorized(message, true);
      }
      return;
    }

    // All remaining commands are admin-only; non-admins are ignored.
    if (!this.access.isAdmin(fromId)) {
      this.deps.logger("info", "ignoring admin command from non-admin", { fromId, cmd: cmd.name });
      return;
    }

    switch (cmd.name) {
      case "allowlist":
        this.replyNotice(room, `Allowed: ${this.access.listAllowed().join(", ") || "(none)"}`);
        return;
      case "pending":
        this.replyNotice(room, `Pending: ${this.access.listPending().join(", ") || "(none)"}`);
        return;
      case "allow": {
        const target = cmd.args[0];
        if (!target) return void this.replyNotice(room, "Usage: /allow <user_id>");
        this.access.allowUser(target);
        this.deps.logger("info", "allowlist grant", { by: fromId, target });
        this.replyNotice(room, `Allowed ${target}.`);
        this.replyNotice(target, "You've been granted access. Send @<agent> <message> to reach an agent.");
        return;
      }
      case "deny": {
        const target = cmd.args[0];
        if (!target) return void this.replyNotice(room, "Usage: /deny <user_id>");
        this.access.denyUser(target);
        this.deps.logger("info", "allowlist revoke", { by: fromId, target });
        this.replyNotice(room, `Denied ${target}.`);
        return;
      }
    }
  }

  /**
   * An unauthorized human reached the hub. With pairing on, queue them for admin
   * approval and notify admins; otherwise drop silently (an explicit `/start`
   * still gets told their id so an admin can add them).
   */
  private handleUnauthorized(message: InboundMessage, explicit: boolean): void {
    const { fromId, room } = message;
    if (this.pairing) {
      if (this.access.addPending(fromId)) {
        this.notifyAdmins(`🔔 access request from ${fromId} — /allow ${fromId} to approve.`);
      }
      this.replyNotice(room, `Your access request (id ${fromId}) is pending admin approval.`);
      return;
    }
    if (explicit) {
      this.replyNotice(room, `Not authorized. Ask an admin to run /allow ${fromId}.`);
      return;
    }
    this.deps.logger("warn", "dropping non-allowlisted sender", { fromId });
  }

  /** Post a hub-generated notice (e.g. presence) to every configured room. */
  private postToRooms(notice: OutboundMessage): void {
    for (const room of this.deps.config.rooms) {
      void this.deps.adapter
        .send({ adapter: this.deps.adapter.name, room }, notice)
        .catch((err: unknown) => {
          this.deps.logger("warn", "room notice send failed", { room, error: String(err) });
        });
    }
  }

  /**
   * Deliver a hub-wide notice (presence, duplicate-registration) to the operator
   * per `HUB_NOTIFY`: admins' DMs and/or the configured rooms. DM delivery means
   * these reach the operator even in a DM-only deployment with no group.
   */
  private notify(notice: OutboundMessage): void {
    if (this.notifyTarget === "dm" || this.notifyTarget === "both") {
      for (const adminId of this.access.adminIds()) this.replyNotice(adminId, notice.text);
    }
    if (this.notifyTarget === "rooms" || this.notifyTarget === "both") {
      this.postToRooms(notice);
    }
  }

  /** adapter → hub: a normalized platform inbound message (optionally with a file). */
  private async onInbound(message: InboundMessage, file?: FilePayload): Promise<void> {
    // Access control applies to real senders; agent-origin traffic is hub-internal.
    if (message.fromKind === "human") {
      // In-chat allowlist commands (a known `/name`) are handled before the access
      // check, so `/start` from an unknown sender and admin commands both work.
      const cmd = parseCommand(message.text);
      if (cmd && KNOWN_COMMANDS.has(cmd.name)) {
        this.handleCommand(message, cmd);
        return;
      }
      if (!this.access.isAllowed(message.fromId)) {
        this.handleUnauthorized(message, false);
        return;
      }
    }

    // Any human message refills the room's coordination thread (human presence =
    // license to continue), unfreezing agent↔agent routing there.
    this.governor.refill(message.room);

    // Voice notes carry no `@tags`, so resolve their recipients (and echo the
    // transcript) before the mention check below. Returns false when it handled
    // the message with a notice (disabled / unclear / unaddressed).
    if (message.voice && !this.handleVoiceAddressing(message)) return;

    // Operator broadcast: `@all` from a human expands to every live agent, so
    // unicast/multicast/broadcast are all just "route to a set" downstream.
    if (message.fromKind === "human" && this.hasBroadcast(message.mentions)) {
      message.mentions = this.expandBroadcast(message.mentions);
      this.deps.logger("info", "broadcast expanded to live agents", {
        room: message.room,
        recipients: message.mentions.length,
      });
    }

    // Explicit-mention-only routing: untagged chatter is not injected.
    if (message.mentions.length === 0) {
      this.deps.logger("debug", "no mentions; not routing", { room: message.room });
      return;
    }

    // Human→agent delivery is never frozen — only agent→agent hops are bounded.
    await this.routeToMentioned(message, file);
  }

  /**
   * Deliver an agent's reply to the room. If the agent set `voice` and TTS is on,
   * try to synthesize a **captioned voice note** (the caption = the attributed full
   * text, the source of truth; the audio = a speakable/sanitized rendering). Falls
   * back to a plain text reply when voice isn't requested, the text isn't speakable
   * (code/links/too long), synthesis fails, or the audio isn't a voice-note format.
   */
  private async postAgentReply(agent: string, reply: ReplyFrame, target: RouteTarget): Promise<void> {
    if (reply.voice && this.synth) {
      // Speak `voiceText` when the agent gave a distinct spoken form; otherwise a
      // sanitized `text`. Either way `text` stays the caption / source of truth (#68).
      const source = reply.voiceText ?? reply.text;
      const spoken = speakableText(source, this.ttsMaxChars);
      if (spoken) {
        try {
          const { audio, mimeType } = await this.synth.synthesize(spoken);
          if (mimeType === "audio/ogg") {
            await this.deps.adapter.sendVoice(target, { agent, audio, mimeType, text: reply.text });
            return;
          }
          this.deps.logger("warn", "tts audio isn't a voice-note format; posting text", { mimeType });
        } catch (err) {
          this.deps.logger("warn", "tts synthesis failed; posting text", { error: String(err) });
        }
      } else {
        // The reply was voice-requested but isn't speakable (too long, or all
        // code/links/paths). Log why the voice didn't go out — a "missing" voice
        // note is then diagnosable rather than a silent fallback (#67).
        this.deps.logger("info", "voiced reply not speakable; posting text", {
          agent,
          chars: source.length,
          maxChars: this.ttsMaxChars,
        });
      }
    } else if (reply.voice && !this.synth) {
      this.deps.logger("info", "voiced reply requested but TTS is disabled; posting text", { agent });
    }
    await this.deps.adapter.send(target, { agent, text: reply.text, kind: "reply" });
  }

  /** Whether the mention set carries an enabled broadcast token (`@all`, …). */
  private hasBroadcast(mentions: string[]): boolean {
    return this.broadcast && mentions.some(isBroadcastMention);
  }

  /** Expand a broadcast mention set to every live agent, keeping any explicit names. */
  private expandBroadcast(mentions: string[]): string[] {
    const explicit = mentions.filter((m) => !isBroadcastMention(m));
    return [...new Set([...this.registry.list(), ...explicit])];
  }

  /**
   * Resolve and echo a voice note. Addressing priority: reply-to (already in
   * `mentions`) wins; otherwise the transcript's leading names / broadcast keyword.
   * Sets `message.mentions` and posts the transcript echo. Returns false — and
   * posts an explanatory notice — when the note is disabled / unclear / unaddressed,
   * so the caller stops.
   */
  private handleVoiceAddressing(message: InboundMessage): boolean {
    const room = message.room;
    if (!this.voiceEnabled) {
      this.replyNotice(room, voiceDisabledNotice().text);
      return false;
    }
    if (message.text.trim() === "") {
      this.replyNotice(room, voiceUnclearNotice().text);
      return false;
    }
    // Reply-to (if any) already populated mentions; only resolve spoken recipients
    // when it didn't — "you replied to them" is the address, the words are the message.
    if (message.mentions.length === 0) {
      const spoken = resolveSpokenRecipients(message.text, this.registry.list());
      message.mentions = spoken.broadcast ? this.registry.list() : spoken.recipients;
    }
    if (message.mentions.length === 0) {
      this.replyNotice(room, voiceUnaddressedNotice().text);
      return false;
    }
    if (this.voiceEcho) {
      this.replyNotice(room, transcriptEchoNotice(message.mentions, message.text).text);
    }
    this.deps.logger("info", "voice note routed", {
      room,
      recipients: message.mentions.length,
    });
    return true;
  }

  /** session → hub → adapter: deliver an agent's file out to a room. */
  private onSendFile(agent: string, frame: SendFileFrame): void {
    const target: RouteTarget = { adapter: this.deps.adapter.name, room: frame.room };
    const out = {
      agent,
      file: frame.file,
      ...(frame.caption ? { caption: frame.caption } : {}),
    };
    void this.deps.adapter.sendFile(target, out).catch((err: unknown) => {
      this.deps.logger("warn", "adapter sendFile failed", { error: String(err) });
    });
  }

  /** hub → adapter: a session's reply. */
  private onReply(agent: string, reply: ReplyFrame): void {
    // 0) The speaker just produced a reply → satisfy any SLA ask that was waiting
    // on it in this room (an ETA ack and a full answer both count as "spoke").
    this.sla?.onAgentSpoke(reply.room, agent);

    // 1) Post the human-visible copy — a captioned voice note if the agent asked
    // (and it's speakable), otherwise text.
    const target: RouteTarget = {
      adapter: this.deps.adapter.name,
      room: reply.room,
      ...(reply.replyToId ? { replyToId: reply.replyToId } : {}),
    };
    void this.postAgentReply(agent, reply, target).catch((err: unknown) => {
      this.deps.logger("warn", "adapter send failed", { error: String(err) });
    });

    // 2) Agent↔agent: re-inject the hop into any tagged peer agents, bounded by
    // the loop governor. The platform never delivers bot→bot, so the hub carries
    // it; the human already sees the visible copy posted above. Broadcast is an
    // operator-only primitive — drop any broadcast token from an agent's mentions
    // so a single reply can't fan out to the whole room.
    const mentions = this.broadcast
      ? reply.mentions.filter((m) => !isBroadcastMention(m))
      : reply.mentions;
    const peers = mentions.filter((m) => m !== agent);
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
        mentions,
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
  private async routeToMentioned(message: InboundMessage, file?: FilePayload): Promise<void> {
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
      session.send({ type: "inbound", message, ...(file ? { file } : {}) });
      this.deps.logger("debug", "injected inbound", {
        agent,
        room: message.room,
        fromKind: message.fromKind,
        hasFile: file !== undefined,
      });
    }
  }
}
