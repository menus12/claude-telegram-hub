import type { Logger } from "./logger.js";

export interface SynthesisResult {
  audio: Buffer;
  /** MIME of the returned audio, e.g. `audio/ogg` for opus (a Telegram voice note). */
  mimeType: string;
}

/**
 * The pluggable text-to-speech seam — the outbound mirror of {@link
 * ./transcription.ts TranscriptionService}. The hub hands short reply text here and
 * gets audio back, which the adapter sends as a voice note. Implementations point
 * at whatever engine a deployment chooses (self-hosted Piper/Kokoro for on-prem, or
 * a cloud API) — a config swap, not a code change. See docs/design/voice-messages.md.
 */
export interface SynthesisService {
  synthesize(text: string, opts?: { voice?: string }): Promise<SynthesisResult>;
}

export interface HttpSynthesisOptions {
  /** Service base URL; `/v1/audio/speech` is appended. */
  url: string;
  /** Model id sent to the service (server-specific). */
  model: string;
  /** Voice id sent to the service (language-specific). */
  voice: string;
  /** Response format; `opus` (→ OGG/Opus, Telegram's voice-note format) by default. */
  format?: string;
  /** Request timeout; defaults to 30s. */
  timeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Map a requested response_format to the MIME we tell the adapter to send it as. */
const FORMAT_MIME: Record<string, string> = {
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

/**
 * A {@link SynthesisService} for any OpenAI-compatible speech endpoint
 * (`POST <url>/v1/audio/speech`), which self-hosted TTS servers (kokoro-fastapi,
 * openai-edge-tts, speaches) and the OpenAI API all speak. Requesting
 * `response_format: opus` returns OGG/Opus — exactly Telegram's voice-note format —
 * so no transcoding is needed. Only global `fetch` — no SDK.
 */
export class HttpSynthesisService implements SynthesisService {
  private readonly endpoint: string;

  constructor(private readonly opts: HttpSynthesisOptions) {
    this.endpoint = `${opts.url.replace(/\/$/, "")}/v1/audio/speech`;
  }

  async synthesize(text: string, opts?: { voice?: string }): Promise<SynthesisResult> {
    const format = this.opts.format ?? "opus";
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        input: text,
        voice: opts?.voice ?? this.opts.voice,
        response_format: format,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`speech service returned ${res.status} ${res.statusText}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    // Derive the MIME from the format we requested (reliable) rather than trusting
    // a possibly-generic response header.
    return { audio, mimeType: FORMAT_MIME[format] ?? "application/octet-stream" };
  }
}
