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
        clearTimeout(registerTimer);
        session = this.handleRegister(ws, frame);
        return;
      }

      switch (frame.type) {
        case "reply":
          this.opts.onReply(session.agent, frame);
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
      }
    });

    ws.on("error", (err: Error) => {
      this.opts.logger("warn", "session socket error", { error: err.message });
    });
  }

  private handleRegister(ws: WebSocket, frame: RegisterFrame): Session | undefined {
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
    return session;
  }

  private sendFrame(ws: WebSocket, frame: HubToSessionFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }
}
