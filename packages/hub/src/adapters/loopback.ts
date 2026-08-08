import type {
  FilePayload,
  InboundMessage,
  OutboundFile,
  OutboundMessage,
  RouteTarget,
} from "@claude-telegram-hub/protocol";
import type { Inbox, OutboundVoice, TransportAdapter } from "../adapter.js";

export interface SentMessage {
  target: RouteTarget;
  out: OutboundMessage;
}

export interface SentFile {
  target: RouteTarget;
  out: OutboundFile;
}

export interface SentVoice {
  target: RouteTarget;
  out: OutboundVoice;
}

/**
 * An in-memory adapter for development and tests. It carries no real platform:
 * `deliver()` simulates a platform inbound, and every outbound is recorded in
 * `sent` (and awaitable via `waitForSent`). Lets the hub's routing be exercised
 * end-to-end without Telegram.
 */
export class LoopbackAdapter implements TransportAdapter {
  readonly name = "loopback";
  readonly sent: SentMessage[] = [];
  readonly sentFiles: SentFile[] = [];
  readonly sentVoices: SentVoice[] = [];
  private inbox: Inbox | undefined;
  private waiters: Array<{
    pred: (s: SentMessage) => boolean;
    resolve: (s: SentMessage) => void;
  }> = [];

  start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    return Promise.resolve();
  }

  send(target: RouteTarget, out: OutboundMessage): Promise<void> {
    const sent: SentMessage = { target, out };
    this.sent.push(sent);
    this.waiters = this.waiters.filter((w) => {
      if (w.pred(sent)) {
        w.resolve(sent);
        return false;
      }
      return true;
    });
    return Promise.resolve();
  }

  sendFile(target: RouteTarget, out: OutboundFile): Promise<void> {
    this.sentFiles.push({ target, out });
    return Promise.resolve();
  }

  sendVoice(target: RouteTarget, out: OutboundVoice): Promise<void> {
    this.sentVoices.push({ target, out });
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.inbox = undefined;
    return Promise.resolve();
  }

  /** Simulate a platform message arriving at the hub (optionally with a file). */
  deliver(message: InboundMessage, file?: FilePayload): Promise<void> {
    if (!this.inbox) throw new Error("loopback adapter not started");
    return this.inbox(message, file);
  }

  /** Resolve with the next outbound matching `pred` (or the next one at all). */
  waitForSent(pred: (s: SentMessage) => boolean = () => true): Promise<SentMessage> {
    const existing = this.sent.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }
}
