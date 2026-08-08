import type { SynthesisResult, SynthesisService } from "../src/index.js";

/**
 * In-memory {@link SynthesisService} for tests. Returns a fixed result or the
 * result of a function (which may throw to simulate a failure); records the text.
 */
export class FakeSynthesisService implements SynthesisService {
  readonly calls: string[] = [];

  constructor(
    private readonly result:
      | SynthesisResult
      | ((text: string) => SynthesisResult) = {
      audio: Buffer.from("OGG-OPUS"),
      mimeType: "audio/ogg",
    },
  ) {}

  synthesize(text: string): Promise<SynthesisResult> {
    this.calls.push(text);
    const r = typeof this.result === "function" ? this.result(text) : this.result;
    return Promise.resolve(r);
  }
}
