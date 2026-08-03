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

  close(): void {
    this.ws.close();
  }
}
