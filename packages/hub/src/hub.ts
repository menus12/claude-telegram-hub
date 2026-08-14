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
import { isBroadcastMention, isOperatorMention, speakableText } from "@claude-telegram-hub/protocol";
import { resolveSpokenRecipients } from "./voice-routing.js";
import { pickVoice } from "./voice-lang.js";
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
import { SettingsStore, TUNABLES, tunableByKey } from "./settings.js";
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
  private readonly settings: SettingsStore;
  private readonly voiceEnabled: boolean;
  private readonly synth: SynthesisService | undefined;
  private readonly governor: LoopGovernor;
  // Presence and SLA are always constructed so they can be toggled at runtime;
  // their entry points are gated on the effective `presence`/`sla` setting.
  private readonly presence: PresenceTracker;
  private readonly sla: ResponseSla;
  // The most recent inbound the hub injected into each agent, so `ttsAuto:
  // reply-to-voice` can tell whether a reply answers an operator voice note (#88).
  private readonly lastInboundTo = new Map<string, { room: string; human: boolean; voice: boolean }>();
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
    this.settings = new SettingsStore({
      ...(deps.config.stateFile ? { stateFile: deps.config.stateFile } : {}),
      logger: deps.logger,
    });
    this.voiceEnabled = deps.config.sttUrl !== undefined;
    this.synth = deps.synth;
    this.governor = new LoopGovernor(deps.config.hopBudget);
    this.sla = new ResponseSla({
      ackSlaMs: deps.config.ackSlaMs,
      answerSlaMs: deps.config.answerSlaMs,
      nudge: (ask) => this.nudgePeer(ask),
      escalate: (ask) => this.escalateAsk(ask),
      ...(deps.scheduler ? { schedule: deps.scheduler } : {}),
    });
    // Presence delivery goes through notify() (admin DMs and/or rooms), so it works
    // even with no group configured. Both are gated on the effective setting below.
    this.presence = new PresenceTracker({
      graceMs: deps.config.presenceGraceMs,
      isLive: (agent) => this.registry.has(agent),
      emit: (notice) => this.notify(notice),
    });
    this.server = new SessionServer({
      host: deps.config.bindHost,
      port: deps.config.bindPort,
      sessionSecret: deps.config.sessionSecret,
      registry: this.registry,
      onReply: (agent, reply) => this.onReply(agent, reply),
      onSendFile: (agent, frame) => this.onSendFile(agent, frame),
      onRegister: (agent) => {
        if (this.effective("presence")) this.presence.onConnect(agent);
      },
      onDetach: (agent) => {
        if (this.effective("presence")) this.presence.onDetach(agent);
      },
      onDuplicateRejected: (agent) => this.notify(duplicateRegistrationNotice(agent)),
      duplicateName: deps.config.duplicateName,
      keepaliveMs: deps.config.keepaliveMs,
      // Advertise voice-reply capability so the channel can tell a sending agent
      // when its voice:true reply won't be voiced (too long / unspeakable) (#74).
      voiceReply: { enabled: this.synth !== undefined, maxChars: this.effective("ttsMaxChars") },
      isReady: () => this.started,
      logger: deps.logger,
    });
  }

  /**
   * The effective value of a runtime-tunable config field: a `/set` override (a
   * room override wins for room-scoped settings) if present, else the env-loaded
   * baseline. Read at the point of use so a `/set` takes effect on the next message.
   */
  private effective<K extends keyof HubConfig>(field: K, room?: string): HubConfig[K] {
    const override = this.settings.getOverride(field, room);
    return (override ?? this.deps.config[field]) as HubConfig[K];
  }

  /**
   * Whether to auto-voice a reply that didn't set `voice` explicitly, per the
   * effective `ttsAuto` mode: `on` voices any speakable reply; `reply-to-voice`
   * voices only when this agent's most recent injected inbound was an operator
   * **voice** note in this room — so agent↔agent and replies to text stay text
   * (#88); `off` never auto-voices.
   */
  private autoVoice(agent: string, room: string): boolean {
    const mode = this.effective("ttsAuto");
    if (mode === "on") return true;
    if (mode === "reply-to-voice") {
      const last = this.lastInboundTo.get(agent);
      return !!last && last.room === room && last.human && last.voice;
    }
    return false;
  }

  async start(): Promise<void> {
    await this.server.listen();
    await this.deps.adapter.start((m, f) => this.onInbound(m, f));
    this.started = true;
    this.deps.logger("info", "hub started", { adapter: this.deps.adapter.name });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.presence.stop();
    this.sla.stop();
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
        // Mention the operator so the escalation breaks through a muted chat (#94).
        { ...slaEscalationNotice(ask.from, ask.to, minutes), ...this.operatorMention() },
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

  /**
   * The operator-mention fields for an outbound message: the configured operator
   * `@username`s (which trip the muted-chat mention exception) plus the admin
   * id-links as a fallback. The adapter prefers usernames and renders the id-link
   * only when none are configured. Empty object when neither is available. (#94)
   */
  private operatorMention(): { mentionUserIds?: string[]; mentionUsernames?: string[] } {
    const usernames = this.deps.config.operatorUsernames;
    const ids = this.access.adminIds();
    return {
      ...(ids.length ? { mentionUserIds: ids } : {}),
      ...(usernames.length ? { mentionUsernames: usernames } : {}),
    };
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
      case "config":
        this.replyNotice(room, this.renderConfig(room));
        return;
      case "set":
        this.handleSet(room, cmd.args, fromId);
        return;
      case "unset":
        this.handleUnset(room, cmd.args, fromId);
        return;
      case "voice": {
        // Friendly alias for the room-scoped voice toggle (#70). Admin-only (#config).
        const arg = cmd.args[0]?.toLowerCase();
        if (arg !== "on" && arg !== "off") {
          return void this.replyNotice(room, "Usage: /voice on|off");
        }
        this.access.setRoomVoice(room, arg === "on");
        this.deps.logger("info", "room voice preference set", { by: fromId, room, on: arg === "on" });
        this.replyNotice(
          room,
          arg === "on"
            ? "🔊 Voice replies on for this room."
            : "🔇 Voice replies off for this room — replies will come as text.",
        );
        return;
      }
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

  /** Render the effective value of every runtime-tunable setting for `/config`. */
  private renderConfig(room: string): string {
    const lines = TUNABLES.map((t) => {
      const override = this.settings.getOverride(t.field, room);
      const value = t.format(override ?? this.deps.config[t.field]);
      const scope = t.scope === "room" ? " [room]" : "";
      const flag = override !== undefined ? " *" : "";
      return `• ${t.key} = ${value}${scope}${flag}`;
    });
    const voiceOff = this.access.isRoomVoiceOff(room);
    lines.push(`• voice = ${voiceOff ? "off" : "on"} [room]${voiceOff ? " *" : ""}`);
    return [
      "Settings (* = overridden; env baseline otherwise):",
      ...lines,
      "Change with /set <key> <value>, revert with /unset <key>.",
    ].join("\n");
  }

  /** `/set <key> <value>` — validate against the tunable, apply, and persist. */
  private handleSet(room: string, args: string[], by: string): void {
    const key = args[0]?.toLowerCase();
    if (!key || args.length < 2) {
      return void this.replyNotice(room, "Usage: /set <key> <value> — /config lists keys.");
    }
    if (key === "voice") {
      return void this.replyNotice(room, "Use /voice on|off for the per-room voice toggle.");
    }
    const tunable = tunableByKey(key);
    if (!tunable) {
      return void this.replyNotice(room, `Unknown or restart-only setting "${key}". /config lists what's tunable.`);
    }
    const raw = args.slice(1).join(" ");
    let value: unknown;
    try {
      value = tunable.parse(raw);
    } catch (err) {
      return void this.replyNotice(room, `Invalid value for ${key}: ${(err as Error).message}`);
    }
    // Keep the SLA invariant answerSlaMs > ackSlaMs (the same cross-field check the
    // env loader enforces), against the *other* field's effective value.
    if (tunable.field === "ackSlaMs" || tunable.field === "answerSlaMs") {
      const ack = tunable.field === "ackSlaMs" ? (value as number) : this.effective("ackSlaMs");
      const answer = tunable.field === "answerSlaMs" ? (value as number) : this.effective("answerSlaMs");
      if (answer <= ack) {
        return void this.replyNotice(room, `answerslams (${answer}) must be greater than ackslams (${ack}).`);
      }
    }
    this.settings.set(tunable, value, room);
    this.applyTunable(tunable.field);
    this.deps.logger("info", "setting changed", { by, key, scope: tunable.scope });
    this.replyNotice(room, `✅ ${key} = ${tunable.format(value)}${tunable.scope === "room" ? " (this room)" : ""}.`);
  }

  /** `/unset <key>` — drop a runtime override, reverting to the env baseline. */
  private handleUnset(room: string, args: string[], by: string): void {
    const key = args[0]?.toLowerCase();
    if (!key) return void this.replyNotice(room, "Usage: /unset <key>");
    const tunable = tunableByKey(key);
    if (!tunable) {
      return void this.replyNotice(room, `Unknown setting "${key}".`);
    }
    const existed = this.settings.unset(tunable, room);
    this.applyTunable(tunable.field);
    this.deps.logger("info", "setting reverted", { by, key, existed });
    this.replyNotice(
      room,
      existed
        ? `↩️ ${key} reverted to the deployment default (${tunable.format(this.deps.config[tunable.field])}).`
        : `${key} had no override.`,
    );
  }

  /**
   * Push a Tier-2 setting change into its live component (Tier-1 settings are read
   * at the point of use, so they fall through as a no-op). Called after a `/set` or
   * `/unset` with the effective (post-change) values.
   */
  private applyTunable(field: keyof HubConfig): void {
    switch (field) {
      case "sla":
        if (!this.effective("sla")) this.sla.stop(); // cancel pending watches when disabled
        break;
      case "presence":
        if (!this.effective("presence")) this.presence.stop();
        break;
      case "ackSlaMs":
      case "answerSlaMs":
        this.sla.reconfigure(this.effective("ackSlaMs"), this.effective("answerSlaMs"));
        break;
      case "presenceGraceMs":
        this.presence.reconfigure(this.effective("presenceGraceMs"));
        break;
      case "hopBudget":
        this.governor.reconfigure(this.effective("hopBudget"));
        break;
      case "keepaliveMs":
        this.server.reconfigure(this.effective("keepaliveMs"));
        break;
    }
  }

  /**
   * An unauthorized human reached the hub. With pairing on, queue them for admin
   * approval and notify admins; otherwise drop silently (an explicit `/start`
   * still gets told their id so an admin can add them).
   */
  private handleUnauthorized(message: InboundMessage, explicit: boolean): void {
    const { fromId, room } = message;
    if (this.effective("pairing")) {
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
    const target = this.effective("notify");
    if (target === "dm" || target === "both") {
      for (const adminId of this.access.adminIds()) this.replyNotice(adminId, notice.text);
    }
    if (target === "rooms" || target === "both") {
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
   * Deliver an agent's reply to the room. Voice it when the agent set `voice: true`
   * — or, under `HUB_TTS_AUTO`, whenever the agent didn't explicitly opt out
   * (`voice: false`) and the reply is speakable (#69). The voice note is captioned
   * with the attributed full `text` (the source of truth); the audio is a
   * speakable/sanitized rendering (or `voiceText`). Falls back to a plain text reply
   * when voice isn't wanted, the text isn't speakable (code/links/too long),
   * synthesis fails, or the audio isn't a voice-note format.
   */
  private async postAgentReply(agent: string, reply: ReplyFrame, target: RouteTarget): Promise<void> {
    // An `@operator` in the reply asks the hub to mention the human — render a real
    // Telegram mention so it reaches them even in a muted chat (#94). Prefer the
    // configured operator `@username`s (these trip the muted-chat mention exception);
    // the admin id-links are the fallback when no username is configured.
    const withMention = reply.mentions.some(isOperatorMention) ? this.operatorMention() : {};
    // `voice: true`/`false` is an explicit choice; when unset, the auto mode decides.
    // A room where an operator ran `/voice off` gets text regardless (#70).
    const wantsVoice =
      (reply.voice ?? this.autoVoice(agent, reply.room)) && !this.access.isRoomVoiceOff(reply.room);
    if (wantsVoice && this.synth) {
      // Speak `voiceText` when the agent gave a distinct spoken form; otherwise a
      // sanitized `text`. Either way `text` stays the caption / source of truth (#68).
      const source = reply.voiceText ?? reply.text;
      const maxChars = this.effective("ttsMaxChars");
      const spoken = speakableText(source, maxChars);
      if (spoken) {
        try {
          // Pick a voice matching the reply's language for a bilingual room (#71);
          // no map → the synth's default voice.
          const voice = pickVoice(
            spoken,
            this.effective("ttsVoice"),
            this.effective("ttsVoiceMap"),
          );
          const { audio, mimeType } = await this.synth.synthesize(
            spoken,
            voice ? { voice } : {},
          );
          if (mimeType === "audio/ogg") {
            await this.deps.adapter.sendVoice(target, { agent, audio, mimeType, text: reply.text, ...withMention });
            return;
          }
          this.deps.logger("warn", "tts audio isn't a voice-note format; posting text", { mimeType });
        } catch (err) {
          this.deps.logger("warn", "tts synthesis failed; posting text", { error: String(err) });
        }
      } else if (reply.voice === true) {
        // Explicitly voice-requested but not speakable (too long, or all
        // code/links/paths). Log why the voice didn't go out — a "missing" voice
        // note is then diagnosable rather than a silent fallback (#67). Under auto
        // mode a non-speakable reply staying text is expected, so we don't log it.
        this.deps.logger("info", "voiced reply not speakable; posting text", {
          agent,
          chars: source.length,
          maxChars,
        });
      }
    } else if (reply.voice === true && !this.synth) {
      this.deps.logger("info", "voiced reply requested but TTS is disabled; posting text", { agent });
    }
    await this.deps.adapter.send(target, { agent, text: reply.text, kind: "reply", ...withMention });
  }

  /** Whether the mention set carries an enabled broadcast token (`@all`, …). */
  private hasBroadcast(mentions: string[]): boolean {
    return this.effective("broadcast") && mentions.some(isBroadcastMention);
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
    if (this.effective("voiceEcho")) {
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
    this.sla.onAgentSpoke(reply.room, agent);

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
    const mentions = this.effective("broadcast")
      ? reply.mentions.filter((m) => !isBroadcastMention(m))
      : reply.mentions;
    // `operator` addresses the human (rendered as a mention in the visible copy),
    // not a peer agent — keep it out of agent re-injection (#94).
    const peers = mentions.filter((m) => m !== agent && !isOperatorMention(m));
    if (peers.length > 0) {
      const decision = this.governor.onAgentHop(reply.room);
      if (!decision.allowed) {
        this.deps.logger("info", "agent↔agent routing frozen; hop dropped", {
          room: reply.room,
          from: agent,
          to: peers.join(", "),
        });
        // Tell the sender its hop wasn't delivered. Otherwise a frozen thread
        // silently swallows agent↔agent messages and the sender waits forever for a
        // reply that can't arrive (the visible room copy still posted, so it looks
        // sent) — the exact "agents can't hear each other" failure. With this, the
        // sender knows to summarize for the operator (or `@operator`) instead. The
        // freeze lifts on the next human message.
        const sender = this.registry.get(agent);
        if (sender) {
          const to = peers.map((p) => `@${p}`).join(" ");
          sender.send({
            type: "inbound",
            message: {
              adapter: this.deps.adapter.name,
              room: reply.room,
              fromKind: "agent",
              fromId: "hub",
              text: `⏸ agent↔agent routing is paused (loop guard): your message to ${to} was NOT delivered — the coordination thread is frozen until the operator posts. Don't wait on a reply; summarize what you need and use @operator if it's blocking.`,
              mentions: [agent],
            },
          });
        }
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
        if (this.effective("sla") && this.registry.has(peer)) {
          this.sla.openAsk({ room: reply.room, from: agent, to: peer, text: reply.text });
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
      // Remember what this agent last saw, for reply-to-voice auto-voicing (#88).
      this.lastInboundTo.set(agent, {
        room: message.room,
        human: message.fromKind === "human",
        voice: message.voice === true,
      });
      this.deps.logger("debug", "injected inbound", {
        agent,
        room: message.room,
        fromKind: message.fromKind,
        hasFile: file !== undefined,
      });
    }
  }
}
