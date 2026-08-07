import type {
  OutgoingFile,
  SendFileOptions,
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

export interface SentFile {
  chatId: string;
  kind: "photo" | "document";
  filename: string;
  bytes: Buffer;
  opts?: SendFileOptions;
  messageId: number;
}

/** In-memory TelegramApi for tests: push inbound messages, capture sends. */
export class FakeTelegramApi implements TelegramApi {
  readonly sent: SentText[] = [];
  readonly sentFiles: SentFile[] = [];
  /** Bytes returned by downloadFile, keyed by file id (set via `setFile`). */
  private readonly files = new Map<string, Buffer>();
  started = false;
  private handler: ((msg: TgMessage) => void) | undefined;
  private readonly pendingErrors: Error[] = [];
  private nextMessageId = 1000;

  /** Register bytes that `downloadFile(fileId)` should return. */
  setFile(fileId: string, bytes: Buffer): void {
    this.files.set(fileId, bytes);
  }

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

  downloadFile(fileId: string): Promise<Buffer | undefined> {
    return Promise.resolve(this.files.get(fileId));
  }

  sendPhoto(
    chatId: string,
    file: OutgoingFile,
    opts?: SendFileOptions,
  ): Promise<number | undefined> {
    const messageId = this.nextMessageId++;
    this.sentFiles.push({ chatId, kind: "photo", filename: file.filename, bytes: file.bytes, opts, messageId });
    return Promise.resolve(messageId);
  }

  sendDocument(
    chatId: string,
    file: OutgoingFile,
    opts?: SendFileOptions,
  ): Promise<number | undefined> {
    const messageId = this.nextMessageId++;
    this.sentFiles.push({ chatId, kind: "document", filename: file.filename, bytes: file.bytes, opts, messageId });
    return Promise.resolve(messageId);
  }

  /** Simulate a Telegram message arriving. */
  push(msg: TgMessage): void {
    if (!this.handler) throw new Error("no message handler registered");
    this.handler(msg);
  }
}
