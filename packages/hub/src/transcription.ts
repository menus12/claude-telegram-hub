import type { Logger } from "./logger.js";

/** A chunk of audio to transcribe. */
export interface AudioInput {
  bytes: Buffer;
  /** File name to present to the service (extension can hint the format). */
  filename: string;
  mimeType: string;
}

export interface TranscriptionResult {
  text: string;
  /** Detected/used language, if the service reports it (e.g. "ru", "en"). */
  lang?: string;
  /** Optional confidence proxy in [0,1], if the service provides one. */
  confidence?: number;
}

/**
 * The pluggable speech-to-text seam. The hub core stays AI-agnostic: an adapter
 * hands audio bytes here and gets text back, then routes the transcript exactly
 * like a typed message. Implementations point at whatever engine a deployment
 * chooses (self-hosted Whisper for on-prem privacy, or a cloud API) — a config
 * swap, not a code change. See docs/design/voice-messages.md.
 */
export interface TranscriptionService {
  transcribe(audio: AudioInput, opts?: { lang?: string }): Promise<TranscriptionResult>;
}

export interface HttpTranscriptionOptions {
  /** Service base URL; `/v1/audio/transcriptions` is appended. */
  url: string;
  /** Model name sent to the service (e.g. `small`, `medium`). */
  model: string;
  /** Default language: `auto` (omit → detect) or an ISO code. */
  defaultLang?: string;
  /** Request timeout; defaults to 60s. */
  timeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * A {@link TranscriptionService} for any OpenAI-compatible transcription endpoint
 * (`POST <url>/v1/audio/transcriptions`), which self-hosted Whisper servers
 * (faster-whisper-server, whisper.cpp server, LocalAI) and the OpenAI API all
 * speak. The audio is sent as multipart `file`; `model` and (unless `auto`)
 * `language` accompany it. Only global `fetch`/`FormData`/`Blob` — no SDK.
 */
export class HttpTranscriptionService implements TranscriptionService {
  private readonly endpoint: string;

  constructor(private readonly opts: HttpTranscriptionOptions) {
    this.endpoint = `${opts.url.replace(/\/$/, "")}/v1/audio/transcriptions`;
  }

  async transcribe(audio: AudioInput, opts?: { lang?: string }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("file", new Blob([audio.bytes], { type: audio.mimeType }), audio.filename);
    form.append("model", this.opts.model);
    form.append("response_format", "json");
    const lang = opts?.lang ?? this.opts.defaultLang;
    if (lang && lang !== "auto") form.append("language", lang);

    const res = await fetch(this.endpoint, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`transcription service returned ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { text?: string; language?: string };
    return {
      text: (data.text ?? "").trim(),
      ...(data.language ? { lang: data.language } : {}),
    };
  }
}
