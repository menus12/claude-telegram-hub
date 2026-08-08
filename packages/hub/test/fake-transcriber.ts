import type { AudioInput, TranscriptionResult, TranscriptionService } from "../src/index.js";

/**
 * In-memory {@link TranscriptionService} for tests. Returns a fixed string or the
 * result of a function (which may throw to simulate a failure); records every call.
 */
export class FakeTranscriptionService implements TranscriptionService {
  readonly calls: AudioInput[] = [];

  constructor(private readonly reply: string | ((audio: AudioInput) => string) = "") {}

  transcribe(audio: AudioInput): Promise<TranscriptionResult> {
    this.calls.push(audio);
    const text = typeof this.reply === "function" ? this.reply(audio) : this.reply;
    return Promise.resolve({ text });
  }
}
