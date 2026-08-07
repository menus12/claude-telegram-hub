import WebSocket from "ws";
import type { HubToSessionFrame } from "@claude-telegram-hub/protocol";

/**
 * A registered session: one live channel connection, addressed by agent name.
 * Wraps the socket so the rest of the hub never touches `ws` directly.
 */
export class Session {
  constructor(
    readonly agent: string,
    private readonly ws: WebSocket,
  ) {}

  /** Push a frame to the session, if the socket is still open. */
  send(frame: HubToSessionFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  /**
   * Probe liveness with a WebSocket ping, resolving `true` if a pong returns
   * within `timeoutMs`. Used to tell a real duplicate registration (incumbent
   * pongs) from a restart whose old socket is half-open (no pong → dead). The
   * `ws` client answers pings automatically, so this needs no protocol frame.
   */
  isAlive(timeoutMs: number): Promise<boolean> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (alive: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws.off("pong", onPong);
        resolve(alive);
      };
      const onPong = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.ws.once("pong", onPong);
      try {
        this.ws.ping();
      } catch {
        finish(false);
      }
    });
  }

  close(): void {
    this.ws.close();
  }
}
