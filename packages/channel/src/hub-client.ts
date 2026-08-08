import WebSocket, { type RawData } from "ws";
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
}

export interface SendFileInput {
  room: string;
  file: FilePayload;
  caption?: string;
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

type WsFactory = (url: string) => WebSocket;

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

  constructor(
    private readonly cfg: ChannelConfig,
    private readonly events: HubClientEvents,
    private readonly wsFactory: WsFactory = (url) => new WebSocket(url),
  ) {
    this.backoffMs = cfg.reconnectInitialMs;
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
      ...(reply.voice ? { voice: true } : {}),
      ...(reply.voiceText ? { voiceText: reply.voiceText } : {}),
    });
  }

  voiceReplyCaps(): VoiceReplyCapsFrame | undefined {
    return this.voiceReply;
  }

  sendFile(input: SendFileInput): void {
    this.send({
      type: "send_file",
      room: input.room,
      file: input.file,
      ...(input.caption ? { caption: input.caption } : {}),
    });
  }

  private connect(): void {
    const ws = this.wsFactory(this.cfg.hubUrl);
    this.ws = ws;
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
