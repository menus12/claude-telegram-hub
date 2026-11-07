import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "@claude-telegram-hub/channel";
import { z } from "zod";
import { AgentPool, type CloudAgent, type HubClientFactory } from "./agents.js";
import type { BridgeConfig } from "./config.js";
import { CLOUD_INSTRUCTIONS } from "./instructions.js";
import { RateLimiter } from "./rate-limit.js";
import type { TokenStore } from "./tokens.js";

const SWEEP_MS = 30_000;
const NOT_JOINED = "not joined — call `join` (pass your `handle` to keep your name)";

/** One MCP session (one cloud client connection); bound to at most one cloud agent. */
interface McpSession {
  transport: StreamableHTTPServerTransport;
  tokenLabel: string;
  agent?: CloudAgent;
  lastSeen: number;
}

export interface BridgeServerDeps {
  config: BridgeConfig;
  tokens: TokenStore;
  logger: Logger;
  hubClientFactory?: HubClientFactory;
  now?: () => number;
}

class BodyTooLarge extends Error {}

/**
 * The cloud bridge: a streamable-HTTP MCP server for Claude Code on the web. Each
 * joined cloud session becomes an ordinary hub session (one HubClient per agent),
 * so routing, the loop governor, SLA and presence apply unchanged and the hub
 * needs no changes. Every route except `GET /healthz` requires a per-environment
 * bearer (injected by the cloud proxy as a network secret).
 */
export class BridgeServer {
  private readonly http: Server;
  private readonly pool: AgentPool;
  private readonly sessions = new Map<string, McpSession>();
  private readonly authedLimiter: RateLimiter;
  private readonly unauthLimiter: RateLimiter;
  private readonly sendLimiter: RateLimiter;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private unauthRejected = 0;
  private unauthLoggedAt = 0;

  constructor(private readonly deps: BridgeServerDeps) {
    this.now = deps.now ?? Date.now;
    const { config } = deps;
    this.pool = new AgentPool(config, deps.logger, deps.hubClientFactory, this.now);
    this.authedLimiter = new RateLimiter(config.requestsPerMin, this.now);
    this.unauthLimiter = new RateLimiter(config.unauthPerMin, this.now);
    this.sendLimiter = new RateLimiter(config.sendsPerMin, this.now);
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (err instanceof BodyTooLarge) return this.json(res, 413, { error: "body too large" });
        deps.logger("error", "request failed", { error: String(err) });
        if (!res.headersSent) this.json(res, 500, { error: "internal error" });
      });
    });
  }

  start(): Promise<void> {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
    return new Promise((resolve) => {
      this.http.listen(this.deps.config.bindPort, this.deps.config.bindHost, () => {
        this.deps.logger("info", "bridge listening", { host: this.deps.config.bindHost, port: this.port() });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const agent of this.pool.all()) this.pool.leave(agent, "bridge shutting down");
    for (const s of this.sessions.values()) await s.transport.close().catch(() => {});
    this.sessions.clear();
    this.http.closeAllConnections?.();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  port(): number {
    return (this.http.address() as AddressInfo).port;
  }

  /** Live cloud agent names (for tests/diagnostics). */
  agents(): string[] {
    return this.pool.all().filter((a) => !a.closed).map((a) => a.name);
  }

  /** TTL sweep for agents, and drop MCP sessions idle past the TTL. */
  sweep(): void {
    this.pool.sweep();
    const t = this.now();
    for (const [sid, s] of this.sessions) {
      if (t - s.lastSeen > this.deps.config.ttlMs && !(s.agent?.waiting ?? false)) {
        this.sessions.delete(sid);
        s.transport.close().catch(() => {});
      }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://bridge");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    const label = this.deps.tokens.verify(req.headers.authorization);
    if (label === undefined) return this.rejectUnauthenticated(req, res);
    if (!this.authedLimiter.take(label)) return this.json(res, 429, { error: "rate limited" });
    if (url.pathname !== "/mcp") return this.json(res, 404, { error: "not found" });

    const sid = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await this.readJson(req) : undefined;
    let session = typeof sid === "string" ? this.sessions.get(sid) : undefined;
    // A session id only works with the token that opened it.
    if (session && session.tokenLabel !== label) session = undefined;
    if (!session) {
      if (sid !== undefined || req.method !== "POST" || !isInitializeRequest(body)) {
        return this.json(res, sid !== undefined ? 404 : 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: sid !== undefined ? "unknown session" : "no session" },
          id: null,
        });
      }
      session = await this.openSession(label);
    }
    session.lastSeen = this.now();
    await session.transport.handleRequest(req, res, body);
  }

  private async openSession(tokenLabel: string): Promise<McpSession> {
    const session: McpSession = {
      tokenLabel,
      lastSeen: this.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, session);
          this.deps.logger("debug", "mcp session opened", { token: tokenLabel });
        },
      }),
    };
    session.transport.onclose = () => {
      const id = session.transport.sessionId;
      if (id && this.sessions.get(id) === session) this.sessions.delete(id);
    };
    await this.buildMcpServer(session).connect(session.transport);
    return session;
  }

  private buildMcpServer(session: McpSession): McpServer {
    const { config } = this.deps;
    const server = new McpServer(
      { name: "hub", version: "0.1.0" },
      { instructions: CLOUD_INSTRUCTIONS, capabilities: { logging: {} } },
    );
    const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });
    const joined = (): CloudAgent | undefined =>
      session.agent && !session.agent.closed ? session.agent : undefined;

    server.registerTool(
      "join",
      {
        description:
          "Join the hub as a cloud agent. Call once at session start (name = your repo name, task = one line). " +
          "Pass the `handle` from an earlier join to keep the same agent name and queued messages.",
        inputSchema: {
          name: z.string().min(1).max(100),
          task: z.string().max(500),
          handle: z.string().max(64).optional(),
        },
      },
      async ({ name, task, handle }) => {
        const current = joined();
        if (current) {
          current.touch();
          return text({ agent: current.name, handle: current.handle, rebound: true, wait_max_s: config.waitMaxS });
        }
        const r = await this.pool.join({ name, task, handle, tokenLabel: session.tokenLabel });
        if (!r.ok) return fail(r.error);
        session.agent = r.agent;
        return text({
          agent: r.agent.name,
          handle: r.agent.handle,
          rebound: r.rebound,
          pending: r.agent.pending,
          wait_max_s: config.waitMaxS,
        });
      },
    );

    server.registerTool(
      "send",
      {
        description:
          "Post a message to the hub as your agent. `mentions` tags peers (or \"operator\"); `no_reply` marks an FYI. " +
          "`room` defaults to the room of the last message you received (only that kind of room, or the default " +
          "room, is allowed). Returns `pending` = messages waiting for `wait`.",
        inputSchema: {
          text: z.string().min(1).max(4000),
          mentions: z.array(z.string().min(1).max(64)).max(10).optional(),
          no_reply: z.boolean().optional(),
          room: z.string().min(1).max(64).optional(),
        },
      },
      async ({ text: body, mentions, no_reply, room }) => {
        const agent = joined();
        if (!agent) return fail(NOT_JOINED);
        agent.touch();
        if (!this.sendLimiter.take(agent.name)) {
          return fail(`rate limited: at most ${config.sendsPerMin} sends per minute`);
        }
        const to = agent.resolveRoom(room);
        if (to === undefined) {
          return fail("room not allowed: send only to the default room or a room you received a message from");
        }
        if (!agent.hubConnected()) return fail("hub link is reconnecting — retry in a few seconds");
        agent.send({ text: body, mentions, noReply: no_reply, room: to });
        return text({ ok: true, room: to, pending: agent.pending });
      },
    );

    server.registerTool(
      "wait",
      {
        description:
          `Wait for hub messages addressed to you (returns at once if some are queued). Blocks up to timeout_s ` +
          `(max ${config.waitMaxS}, the default). Keep one wait pending while idle; an empty result means call it again.`,
        inputSchema: {
          timeout_s: z.number().int().min(1).optional(),
        },
      },
      async ({ timeout_s }, extra) => {
        const agent = joined();
        if (!agent) return fail(NOT_JOINED);
        const timeoutS = Math.min(timeout_s ?? config.waitMaxS, config.waitMaxS);
        const progressToken = extra._meta?.progressToken;
        const started = this.now();
        const tick =
          progressToken === undefined
            ? undefined
            : setInterval(() => {
                const elapsed = Math.round((this.now() - started) / 1000);
                extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: elapsed, total: timeoutS, message: `waiting ${elapsed}/${timeoutS}s` },
                  })
                  .catch(() => {});
              }, config.progressEveryS * 1000);
        try {
          const r = await agent.wait(timeoutS, extra.signal);
          if (agent.closed) return text({ ...r, left: true, note: NOT_JOINED });
          return text(r);
        } finally {
          if (tick) clearInterval(tick);
        }
      },
    );

    server.registerTool(
      "leave",
      {
        description: "Leave the hub (your agent goes offline). Call when your work is done.",
        inputSchema: { reason: z.string().max(200).optional() },
      },
      async ({ reason }) => {
        const agent = joined();
        if (!agent) return text({ ok: true, note: "was not joined" });
        this.pool.leave(agent, reason?.trim() || "done");
        session.agent = undefined;
        return text({ ok: true });
      },
    );

    return server;
  }

  private rejectUnauthenticated(req: IncomingMessage, res: ServerResponse): void {
    // `cf-connecting-ip` is client-controlled unless Cloudflare set it. Trusting it is
    // sound ONLY because the bridge is reachable solely through cloudflared (bound to
    // 127.0.0.1, or `expose`-only in compose). Never publish the bridge port directly.
    const ip = (req.headers["cf-connecting-ip"] as string | undefined) ?? req.socket.remoteAddress ?? "?";
    this.unauthRejected++;
    const t = this.now();
    if (t - this.unauthLoggedAt >= 60_000) {
      this.deps.logger("info", "rejected unauthenticated requests", { count: this.unauthRejected, lastIp: ip });
      this.unauthRejected = 0;
      this.unauthLoggedAt = t;
    }
    if (!this.unauthLimiter.take(ip)) return this.json(res, 429, { error: "rate limited" });
    this.json(res, 401, { error: "unauthorized" });
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > this.deps.config.maxBodyBytes) throw new BodyTooLarge();
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString();
    if (raw === "") return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }
}
