import { randomBytes } from "node:crypto";
import { HubClient, buildInboundNotification, type Logger } from "@claude-telegram-hub/channel";
import type { ChannelConfig, ErrorCode, InboundFrame } from "@claude-telegram-hub/protocol";
import type { BridgeConfig } from "./config.js";

/** One message as `wait` returns it: the channel's `<channel>` meta plus the text. */
export type WaitMessage = Record<string, string> & { text: string };

export interface WaitResult {
  messages: WaitMessage[];
  /** Messages dropped (oldest first) since the last drain because the queue was full. */
  dropped: number;
  /** True when a newer `wait` call replaced this one. */
  superseded?: boolean;
}

/** The HubClient surface the bridge uses (injectable in tests). */
export type HubClientLike = Pick<HubClient, "start" | "stop" | "sendReply" | "isConnected">;
export type HubClientFactory = (
  cfg: ChannelConfig,
  events: ConstructorParameters<typeof HubClient>[1],
) => HubClientLike;

const MAX_NAME_SLUG = 40;
const MAX_TASK_CHARS = 200;
const MAX_SUFFIX = 9;
const MAX_KNOWN_ROOMS = 20;

/**
 * Normalize an agent-chosen name into `<prefix><slug>`: lowercase, `[a-z0-9-]` only
 * (a valid @mention token), a leading prefix the agent typed itself is not doubled.
 */
export function cloudAgentName(prefix: string, requested: string): string {
  let slug = requested
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.startsWith(prefix)) slug = slug.slice(prefix.length);
  slug = slug.slice(0, MAX_NAME_SLUG).replace(/-$/, "");
  return `${prefix}${slug || "agent"}`;
}

/**
 * A cloud session's presence on the hub: one HubClient (one hub WebSocket) under a
 * `cloud-*` name, plus the inbound queue `wait` drains. It outlives MCP sessions —
 * a new MCP session re-binds it by `handle` — and ends on `leave` or TTL.
 */
export class CloudAgent {
  readonly handle = randomBytes(16).toString("hex");
  private client: HubClientLike | undefined;
  private queue: WaitMessage[] = [];
  private dropped = 0;
  private waiter: ((r: WaitResult) => void) | undefined;
  private lastRoom: string | undefined;
  /** Rooms this agent may post to: the default room plus rooms it was addressed from. */
  private readonly rooms: Set<string>;
  lastActivity: number;
  closed = false;

  constructor(
    readonly name: string,
    readonly tokenLabel: string,
    public task: string,
    private readonly cfg: BridgeConfig,
    private readonly log: Logger,
    private readonly now: () => number,
  ) {
    this.lastActivity = now();
    this.rooms = new Set([cfg.defaultRoom]);
  }

  /** Register with the hub; resolves with undefined on success or the rejection code. */
  connect(factory: HubClientFactory): Promise<ErrorCode | "timeout" | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: ErrorCode | "timeout" | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (r !== undefined) client.stop();
        resolve(r);
      };
      const client = factory(
        {
          hubUrl: this.cfg.hubUrl,
          sessionSecret: this.cfg.sessionSecret,
          agent: this.name,
          logLevel: this.cfg.logLevel,
          reconnectInitialMs: 500,
          reconnectMaxMs: 15_000,
          maxFileMb: 1,
        },
        {
          onInbound: (frame) => this.enqueue(frame),
          onRegistered: () => settle(undefined),
          onHubError: (code, message, fatal) => {
            if (!settled) return settle(code);
            this.log("warn", "hub error for cloud agent", { agent: this.name, code, message, fatal });
            if (fatal) this.close();
          },
          log: (level, msg, meta) => this.log(level, msg, { agent: this.name, ...meta }),
        },
      );
      const timer = setTimeout(() => settle("timeout"), this.cfg.joinTimeoutMs);
      this.client = client;
      client.start();
    });
  }

  touch(): void {
    this.lastActivity = this.now();
  }

  get waiting(): boolean {
    return this.waiter !== undefined;
  }

  get pending(): number {
    return this.queue.length;
  }

  hubConnected(): boolean {
    return !this.closed && (this.client?.isConnected() ?? false);
  }

  /**
   * The room a `send` goes to: the requested one if this agent may post there (the
   * default room, or one it received a message from), else undefined. A bridge
   * token must not be able to address a room it was never addressed from.
   */
  resolveRoom(requested: string | undefined): string | undefined {
    const room = requested ?? this.lastRoom ?? this.cfg.defaultRoom;
    return this.rooms.has(room) ? room : undefined;
  }

  /** Post into a room as this agent (the hub routes it like any session's reply). */
  send(input: { text: string; mentions?: string[]; noReply?: boolean; room: string }): void {
    const { room } = input;
    this.client?.sendReply({
      room,
      text: input.text,
      mentions: input.mentions ?? [],
      ...(input.noReply ? { noReply: true } : {}),
    });
  }

  /** Return queued messages now, or block until one arrives / the timeout / abort. */
  wait(timeoutS: number, signal?: AbortSignal): Promise<WaitResult> {
    this.touch();
    if (this.queue.length > 0 || this.closed) return Promise.resolve(this.drain());
    // One pending wait per agent: a newer call replaces the older one.
    this.waiter?.({ messages: [], dropped: 0, superseded: true });
    return new Promise((resolve) => {
      const finish = (r: WaitResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter === deliver) this.waiter = undefined;
        this.touch();
        resolve(r);
      };
      const deliver = (r: WaitResult) => finish(r);
      const onAbort = () => finish({ messages: [], dropped: 0 });
      const timer = setTimeout(() => finish(this.drain()), timeoutS * 1000);
      signal?.addEventListener("abort", onAbort);
      this.waiter = deliver;
    });
  }

  /** Notice the room, then drop the hub link. Idempotent. */
  leave(reason: string): void {
    if (this.closed) return;
    this.send({ text: `☁️ left — ${reason}`, noReply: true, room: this.cfg.defaultRoom });
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client?.stop();
    // Wake a pending wait so the session learns it was disconnected.
    this.waiter?.(this.drain());
  }

  private enqueue(frame: InboundFrame): void {
    const { params } = buildInboundNotification(frame, { selfAgent: this.name });
    let text = params.content;
    if (frame.file) {
      text += `\n[attachment "${frame.file.filename}" is not available to cloud agents]`;
    }
    this.lastRoom = frame.message.room;
    if (!this.rooms.has(frame.message.room) && this.rooms.size < MAX_KNOWN_ROOMS) {
      this.rooms.add(frame.message.room);
    }
    this.queue.push({ ...params.meta, text });
    if (this.queue.length > this.cfg.queueMax) {
      this.queue.shift();
      this.dropped++;
    }
    if (this.waiter) this.waiter(this.drain());
  }

  private drain(): WaitResult {
    const r = { messages: this.queue, dropped: this.dropped };
    this.queue = [];
    this.dropped = 0;
    return r;
  }
}

export type JoinResult =
  | { ok: true; agent: CloudAgent; rebound: boolean }
  | { ok: false; error: string };

/** All live cloud agents, by name and by handle; owns naming and the TTL sweep. */
export class AgentPool {
  private readonly byName = new Map<string, CloudAgent>();
  private readonly byHandle = new Map<string, CloudAgent>();

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly log: Logger,
    private readonly factory: HubClientFactory = (c, e) => new HubClient(c, e),
    private readonly now: () => number = Date.now,
  ) {}

  /** Re-bind by handle (same token only), else register a fresh `cloud-*` name. */
  async join(opts: { name: string; task: string; tokenLabel: string; handle?: string }): Promise<JoinResult> {
    const task = opts.task.replace(/\s+/g, " ").trim().slice(0, MAX_TASK_CHARS);
    if (opts.handle) {
      const existing = this.byHandle.get(opts.handle);
      if (existing && !existing.closed && existing.tokenLabel === opts.tokenLabel) {
        existing.touch();
        if (task) existing.task = task;
        return { ok: true, agent: existing, rebound: true };
      }
    }
    // Cap live agents per token: each one is a real hub session (presence, SLA,
    // governor state), so one environment must not be able to open unboundedly many.
    const live = this.all().filter((a) => !a.closed && a.tokenLabel === opts.tokenLabel).length;
    if (live >= this.cfg.maxAgentsPerToken) {
      return {
        ok: false,
        error: `this environment already has ${live} live cloud agents (max ${this.cfg.maxAgentsPerToken}); leave one first`,
      };
    }
    const base = cloudAgentName(this.cfg.agentPrefix, opts.name);
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (this.byName.has(name)) continue;
      const agent = new CloudAgent(name, opts.tokenLabel, task, this.cfg, this.log, this.now);
      this.byName.set(name, agent); // reserve while registering
      const rejected = await agent.connect(this.factory);
      if (rejected === undefined) {
        this.byHandle.set(agent.handle, agent);
        agent.send({ text: `☁️ joined — ${task || "no task given"}`, noReply: true, room: this.cfg.defaultRoom });
        this.log("info", "cloud agent joined", { agent: name, token: opts.tokenLabel });
        return { ok: true, agent, rebound: false };
      }
      this.byName.delete(name);
      if (rejected !== "name_in_use") {
        this.log("warn", "cloud agent join rejected", { agent: name, code: rejected });
        return { ok: false, error: `hub rejected the registration (${rejected})` };
      }
    }
    return { ok: false, error: `no free name for "${base}" (tried ${MAX_SUFFIX})` };
  }

  leave(agent: CloudAgent, reason: string): void {
    agent.leave(reason);
    this.forget(agent);
  }

  /** Auto-leave agents with no pending wait and no activity within the TTL. */
  sweep(): void {
    const t = this.now();
    for (const agent of [...this.byName.values()]) {
      if (agent.closed) {
        this.forget(agent);
      } else if (!agent.waiting && t - agent.lastActivity > this.cfg.ttlMs) {
        this.log("info", "cloud agent idle past TTL; leaving", { agent: agent.name });
        this.leave(agent, `idle for ${Math.round(this.cfg.ttlMs / 60_000)} min`);
      }
    }
  }

  all(): CloudAgent[] {
    return [...this.byName.values()];
  }

  private forget(agent: CloudAgent): void {
    if (this.byName.get(agent.name) === agent) this.byName.delete(agent.name);
    this.byHandle.delete(agent.handle);
  }
}
