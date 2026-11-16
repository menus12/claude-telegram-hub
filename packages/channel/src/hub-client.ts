import WebSocket, { type ClientOptions, type RawData } from "ws";
import { connectPlan, upgradeFailureHint, type ConnectPlan } from "./net.js";
import {
  PROTOCOL_VERSION,
  hubToSessionFrameSchema,
  type ChannelConfig,
  type ErrorCode,
  type FilePayload,
  type InboundFrame,
  type LogLevel,
  type SessionToHubFrame,
  type VoiceReplyCapsFrame,
} from "@claude-telegram-hub/protocol";

export interface ReplyInput {
  room: string;
  text: string;
  mentions?: string[];
  replyToId?: string;
  /** Also render this (short) reply as a voice note, if the hub has TTS enabled. */
  voice?: boolean;
  /** Distinct words to speak (vs the displayed `text`), when `voice` is set. */
  voiceText?: string;
  /** Tag peers for visibility without arming a response watch (acks / FYIs). (#100) */
  noReply?: boolean;
}

export interface SendFileInput {
  room: string;
  file: FilePayload;
  caption?: string;
  /** Peer agent names to hand the file to (agent→agent delivery). */
  mentions?: string[];
}

/** The subset of HubClient the channel wiring depends on (injectable in tests). */
export interface HubLike {
  start(): void;
  stop(): void;
  sendReply(reply: ReplyInput): void;
  sendFile(input: SendFileInput): void;
  /**
   * Voice-reply capability advertised by the hub at registration, or `undefined`
   * before registering / from an older hub. Lets the channel tell a sending agent
   * when a `voice: true` reply won't be voiced (#74).
   */
  voiceReplyCaps(): VoiceReplyCapsFrame | undefined;
}

export interface HubClientEvents {
  onInbound: (frame: InboundFrame) => void;
  onRegistered?: (agent: string) => void;
  onHubError?: (code: ErrorCode, message: string, fatal: boolean) => void;
  log?: (level: LogLevel, msg: string, meta?: Record<string, unknown>) => void;
}

type WsFactory = (url: string, options?: ClientOptions) => WebSocket;

/**
 * The session's one persistent link to the hub. Not a poller: it holds a single
 * WebSocket over which the hub pushes inbound messages and the session sends
 * replies. Registers on connect and reconnects with capped exponential backoff.
 */
export class HubClient implements HubLike {
  private ws: WebSocket | undefined;
  private stopped = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private voiceReply: VoiceReplyCapsFrame | undefined;
  /** How to reach the hub on this network (headers, proxy, CAs), resolved once. */
  private readonly plan: ConnectPlan;
  private planLogged = false;

  constructor(
    private readonly cfg: ChannelConfig,
    private readonly events: HubClientEvents,
    private readonly wsFactory: WsFactory = (url, options) => new WebSocket(url, options),
  ) {
    this.backoffMs = cfg.reconnectInitialMs;
    this.plan = connectPlan(cfg.hubUrl, {
      ...(cfg.headers ? { headers: cfg.headers } : {}),
      ...(cfg.proxy ? { proxy: cfg.proxy } : {}),
      systemCa: cfg.systemCa ?? true,
    });
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = undefined;
  }

  sendReply(reply: ReplyInput): void {
    this.send({
      type: "reply",
      room: reply.room,
      text: reply.text,
      mentions: reply.mentions ?? [],
      ...(reply.replyToId ? { replyToId: reply.replyToId } : {}),
      ...(reply.voice !== undefined ? { voice: reply.voice } : {}),
      ...(reply.voiceText ? { voiceText: reply.voiceText } : {}),
      ...(reply.noReply ? { noReply: reply.noReply } : {}),
    });
  }

  voiceReplyCaps(): VoiceReplyCapsFrame | undefined {
    return this.voiceReply;
  }

  /** Whether the hub link is open right now (frames sent while closed are dropped). */
  isConnected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  sendFile(input: SendFileInput): void {
    this.send({
      type: "send_file",
      room: input.room,
      file: input.file,
      mentions: input.mentions ?? [],
      ...(input.caption ? { caption: input.caption } : {}),
    });
  }

  private connect(): void {
    if (!this.planLogged) {
      this.planLogged = true;
      this.events.log?.("info", "hub link", {
        url: this.cfg.hubUrl,
        proxy: this.plan.proxy ?? "direct",
        systemCa: this.plan.systemCa,
        headers: this.cfg.headers ? Object.keys(this.cfg.headers) : [],
      });
    }
    const ws = this.wsFactory(this.cfg.hubUrl, this.plan.options);
    this.ws = ws;
    // A non-101 answer to the upgrade: say who answered and why it's likely
    // failing (Access, proxy auth, an inspecting proxy stripping the upgrade),
    // then abort so the normal error/close/reconnect path runs (#125).
    ws.on("unexpected-response", (_req, res) => {
      const h = res.headers;
      this.events.log?.("error", "hub connection refused before the WebSocket upgrade", {
        status: res.statusCode,
        ...(h.server ? { server: String(h.server) } : {}),
        ...(h.via ? { via: String(h.via) } : {}),
        ...(h["cache-status"] ? { cacheStatus: String(h["cache-status"]) } : {}),
        ...(h["content-type"] ? { contentType: String(h["content-type"]) } : {}),
        hint: upgradeFailureHint(res.statusCode ?? 0, h),
      });
      res.resume();
      ws.terminate();
    });
    ws.on("open", () => {
      this.backoffMs = this.cfg.reconnectInitialMs;
      this.events.log?.("info", "hub connection open; registering", {
        agent: this.cfg.agent,
      });
      this.send({
        type: "register",
        protocolVersion: PROTOCOL_VERSION,
        agent: this.cfg.agent,
        secret: this.cfg.sessionSecret,
      });
    });
    ws.on("message", (data: RawData) => this.onMessage(data));
    ws.on("error", (err: Error) => {
      this.events.log?.("warn", "hub connection error", { error: err.message });
      if (/unable to get local issuer certificate|self[- ]signed certificate|unable to verify/i.test(err.message)) {
        this.events.log?.("error", "TLS: the hub's certificate isn't trusted — likely a TLS-inspecting proxy", {
          systemCa: this.plan.systemCa,
          hint: this.plan.systemCa
            ? "the OS store didn't help; set NODE_EXTRA_CA_CERTS to the proxy's root CA (PEM)"
            : "enable systemCa, or set NODE_EXTRA_CA_CERTS to the proxy's root CA (PEM)",
        });
      }
    });
    ws.on("close", () => {
      this.events.log?.("info", "hub connection closed");
      this.ws = undefined;
      this.scheduleReconnect();
    });
  }

  private onMessage(data: RawData): void {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      this.events.log?.("warn", "dropping non-JSON frame from hub");
      return;
    }
    const parsed = hubToSessionFrameSchema.safeParse(json);
    if (!parsed.success) {
      this.events.log?.("warn", "dropping unrecognized frame from hub");
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case "registered":
        this.voiceReply = frame.voiceReply;
        this.events.onRegistered?.(frame.agent);
        break;
      case "inbound":
        this.events.onInbound(frame);
        break;
      case "error":
        this.events.onHubError?.(frame.code, frame.message, frame.fatal);
        if (frame.fatal) this.stop();
        break;
    }
  }

  private send(frame: SessionToHubFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.cfg.reconnectMaxMs);
    this.events.log?.("info", "scheduling reconnect", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }
}
