import type {
  SendOptions,
  TelegramApi,
  TgMessage,
} from "../src/adapters/telegram/types.js";

export interface SentText {
  chatId: string;
  text: string;
  opts?: SendOptions;
  /** The message_id assigned to this send (as returned by sendMessage). */
  messageId: number;
}

/** In-memory TelegramApi for tests: push inbound messages, capture sends. */
export class FakeTelegramApi implements TelegramApi {
  readonly sent: SentText[] = [];
  started = false;
  private handler: ((msg: TgMessage) => void) | undefined;
  private readonly pendingErrors: Error[] = [];
  private nextMessageId = 1000;

  /** Make the next sendMessage reject with `err` (once). */
  failNext(err: Error): void {
    this.pendingErrors.push(err);
  }

  onMessage(handler: (msg: TgMessage) => void): void {
    this.handler = handler;
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.started = false;
    return Promise.resolve();
  }

  sendMessage(
    chatId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<number | undefined> {
    const err = this.pendingErrors.shift();
    if (err) return Promise.reject(err);
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId, text, opts, messageId });
    return Promise.resolve(messageId);
  }

  /** Simulate a Telegram message arriving. */
  push(msg: TgMessage): void {
    if (!this.handler) throw new Error("no message handler registered");
    this.handler(msg);
  }
}
