import type { AudioInput, TranscriptionResult, TranscriptionService } from "../src/index.js";

/**
 * In-memory {@link TranscriptionService} for tests. Returns a fixed string or the
 * result of a function (which may throw to simulate a failure); records every call.
 */
export class FakeTranscriptionService implements TranscriptionService {
  readonly calls: AudioInput[] = [];
  readonly options: ({ lang?: string; prompt?: string } | undefined)[] = [];

  constructor(private readonly reply: string | ((audio: AudioInput) => string) = "") {}

  transcribe(
    audio: AudioInput,
    opts?: { lang?: string; prompt?: string },
  ): Promise<TranscriptionResult> {
    this.calls.push(audio);
    this.options.push(opts);
    const text = typeof this.reply === "function" ? this.reply(audio) : this.reply;
    return Promise.resolve({ text });
  }
}
