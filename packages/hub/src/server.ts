import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  isProtocolCompatible,
  sessionToHubFrameSchema,
  type HubToSessionFrame,
  type RegisterFrame,
  type ReplyFrame,
  type SendFileFrame,
} from "@claude-telegram-hub/protocol";
import type { AgentRegistry } from "./registry.js";
import { Session } from "./session.js";
import type { Logger } from "./logger.js";

export interface SessionServerOptions {
  host: string;
  port: number;
  sessionSecret: string;
  registry: AgentRegistry;
  onReply: (agent: string, reply: ReplyFrame) => void;
  /** A session wants a file delivered out to a room. */
  onSendFile?: (agent: string, frame: SendFileFrame) => void;
  /** A session for `agent` just registered (fired after the registry is updated). */
  onRegister?: (agent: string) => void;
  /** A session for `agent` just detached (fired after the registry is updated). */
  onDetach?: (agent: string) => void;
  /**
   * A newcomer was rejected because `agent` is already held by a live session
   * (only in `reject` policy). The hub surfaces this in the room.
   */
  onDuplicateRejected?: (agent: string) => void;
  /**
   * Policy when a name is already registered: `reject` keeps the incumbent (if it's
   * still live) and turns the newcomer away; `replace` takes over. Default `reject`.
   */
  duplicateName?: "reject" | "replace";
  /** Liveness probe for the incumbent on a name collision (injectable for tests). */
  probeAlive?: (session: Session) => Promise<boolean>;
  /** Timeout for the default ping-based liveness probe. */
  probeTimeoutMs?: number;
  /** Readiness probe backing GET /readyz. */
  isReady: () => boolean;
  logger: Logger;
  /** How long a connection may stay unregistered before it's dropped. */
  registerTimeoutMs?: number;
}

/** Constant-time secret comparison (avoids leaking length-independent timing). */
function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * The single session-facing server: HTTP (health probes) + WebSocket (the
 * session↔hub protocol), sharing one port. Exactly one process owns this, so
 * exactly one process owns the transport.
 */
export class SessionServer {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;

  constructor(private readonly opts: SessionServerOptions) {
    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.http.listen(this.opts.port, this.opts.host, () => resolve());
    });
    this.opts.logger("info", "session server listening", {
      host: this.opts.host,
      port: this.port(),
    });
  }

  /** The bound port (useful when configured port is 0 for an ephemeral port). */
  port(): number {
    const addr = this.http.address();
    return addr && typeof addr === "object" ? addr.port : this.opts.port;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" && req.url === "/readyz") {
      const ready = this.opts.isReady();
      res.writeHead(ready ? 200 : 503, { "content-type": "text/plain" });
      res.end(ready ? "ready" : "not ready");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  private onConnection(ws: WebSocket): void {
    let session: Session | undefined;
    let registering = false;

    const registerTimer = setTimeout(() => {
      if (!session) {
        this.sendFrame(ws, {
          type: "error",
          code: "bad_request",
          message: "registration timed out",
          fatal: true,
        });
        ws.close();
      }
    }, this.opts.registerTimeoutMs ?? 5000);

    ws.on("message", (data: RawData) => {
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = sessionToHubFrameSchema.safeParse(json);
      if (!parsed.success) return;
      const frame = parsed.data;

      if (!session) {
        if (frame.type !== "register") return; // ignore until registered
        if (registering) return; // a registration is already in flight (probe running)
        registering = true;
        clearTimeout(registerTimer);
        void this.handleRegister(ws, frame).then((s) => {
          session = s;
          registering = false;
        });
        return;
      }

      switch (frame.type) {
        case "reply":
          this.opts.onReply(session.agent, frame);
          break;
        case "send_file":
          this.opts.onSendFile?.(session.agent, frame);
          break;
        case "heartbeat":
        case "register":
          break; // no-op once registered
      }
    });

    ws.on("close", () => {
      clearTimeout(registerTimer);
      if (session) {
        this.opts.registry.unregister(session);
        this.opts.logger("info", "session detached", { agent: session.agent });
        this.opts.onDetach?.(session.agent);
      }
    });

    ws.on("error", (err: Error) => {
      this.opts.logger("warn", "session socket error", { error: err.message });
    });
  }

  private async handleRegister(
    ws: WebSocket,
    frame: RegisterFrame,
  ): Promise<Session | undefined> {
    if (!isProtocolCompatible(frame.protocolVersion)) {
      this.sendFrame(ws, {
        type: "error",
        code: "version_mismatch",
        message: `hub speaks protocol ${PROTOCOL_VERSION}`,
        fatal: true,
      });
      ws.close();
      return undefined;
    }
    if (!secretEquals(frame.secret, this.opts.sessionSecret)) {
      this.opts.logger("warn", "rejected registration: bad secret", { agent: frame.agent });
      this.sendFrame(ws, {
        type: "error",
        code: "auth_failed",
        message: "invalid session secret",
        fatal: true,
      });
      ws.close();
      return undefined;
    }

    // Duplicate-name guard (default `reject`): if a session already holds this name
    // and is still live, keep it and turn the newcomer away — no split-brain. A
    // dead/half-open incumbent (a restart's old socket) fails the probe and is
    // taken over below, so a genuine reconnect still attaches.
    const incumbent = this.opts.registry.get(frame.agent);
    if (incumbent && (this.opts.duplicateName ?? "reject") === "reject") {
      const alive = await this.probeAlive(incumbent);
      if (alive) {
        this.opts.logger("warn", "rejected duplicate registration; name in use", {
          agent: frame.agent,
        });
        this.sendFrame(ws, {
          type: "error",
          code: "name_in_use",
          message: `agent "${frame.agent}" is already connected`,
          fatal: true,
        });
        ws.close();
        this.opts.onDuplicateRejected?.(frame.agent);
        return undefined;
      }
      this.opts.logger("info", "incumbent session is dead; taking over name", {
        agent: frame.agent,
      });
    }

    // The newcomer's own socket may have dropped during the probe.
    if (ws.readyState !== WebSocket.OPEN) return undefined;

    const session = new Session(frame.agent, ws);
    const displaced = this.opts.registry.register(session);
    if (displaced) {
      this.opts.logger("info", "replacing existing session for agent", { agent: frame.agent });
      displaced.close();
    }
    this.sendFrame(ws, {
      type: "registered",
      agent: frame.agent,
      protocolVersion: PROTOCOL_VERSION,
    });
    this.opts.logger("info", "session registered", { agent: frame.agent });
    this.opts.onRegister?.(frame.agent);
    return session;
  }

  /** Liveness probe for a name-collision incumbent (ping/pong, or an injected fake). */
  private probeAlive(session: Session): Promise<boolean> {
    return this.opts.probeAlive
      ? this.opts.probeAlive(session)
      : session.isAlive(this.opts.probeTimeoutMs ?? 1500);
  }

  private sendFrame(ws: WebSocket, frame: HubToSessionFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }
}
