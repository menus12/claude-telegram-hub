import { z } from "zod";

/**
 * Configuration contract for both artifacts.
 *
 * Every deployment-varying value is a named, validated, documented input — no
 * literals baked into code. The hub image and the channel package are identical
 * across deployments; only the environment differs. Loaders take an explicit
 * `env` map (rather than reaching for `process.env`) so the protocol package
 * stays isomorphic and the loaders are trivially testable.
 */

type Env = Record<string, string | undefined>;

export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Split a comma-separated env value into a trimmed, non-empty list. */
function csv(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return items;
}

/**
 * Coerce a numeric env value. Returns `undefined` for absent/blank (so schema
 * defaults apply) and passes the raw string through on a non-numeric value (so
 * the schema reports a clear "expected number, received string" error).
 */
function num(v: string | undefined): number | string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : v;
}

/**
 * Coerce a boolean env value. Accepts `on/off`, `true/false`, `1/0`, `yes/no`
 * (case-insensitive). Returns `undefined` for absent/blank (so schema defaults
 * apply) and passes an unrecognized string through so the schema reports a clear
 * error rather than silently treating it as false.
 */
function bool(v: string | undefined): boolean | string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (t === "") return undefined;
  if (["on", "true", "1", "yes"].includes(t)) return true;
  if (["off", "false", "0", "no"].includes(t)) return false;
  return v;
}

function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  label: string,
): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const lines = result.error.issues.map(
    (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  throw new Error(`Invalid ${label} configuration:\n${lines.join("\n")}`);
}

// ── hub core (transport-agnostic) ─────────────────────────────────────────────

export const hubConfigSchema = z.object({
  /** Shared secret sessions must present to register. */
  sessionSecret: z.string().min(1),
  /** Platform user ids permitted to talk to the hub; unknown senders are dropped. */
  allowlist: z.array(z.string().min(1)).min(1),
  /** Group room ids the hub operates in. Empty is valid (DM-only deployments). */
  rooms: z.array(z.string().min(1)).default([]),
  /** Coordination-thread hop budget before agent→agent routing freezes. */
  hopBudget: z.number().int().positive().default(6),
  /**
   * Enable the operator broadcast primitive: `@all` (and `@everyone`/`@team`)
   * from a human expands to every live agent in the room. Off → those are treated
   * as ordinary agent names. Agents can't broadcast regardless.
   */
  broadcast: z.boolean().default(true),
  /** Announce agent online/offline in the configured rooms. Off by default. */
  presence: z.boolean().default(false),
  /**
   * Grace window (ms) a dropped session may reconnect within before the hub
   * announces it offline — absorbs restart churn so presence doesn't flap.
   */
  presenceGraceMs: z.number().int().nonnegative().default(10000),
  /**
   * Durable response-SLA backstop for unanswered agent→agent `@`-asks (catches
   * the case where the asker's session died with its own follow-up timer). Off by
   * default.
   */
  sla: z.boolean().default(false),
  /** T1: silence before the hub nudges the peer once. */
  ackSlaMs: z.number().int().positive().default(120000),
  /** T2: silence before the hub escalates to the operator and unblocks the asker. */
  answerSlaMs: z.number().int().positive().default(600000),
  /**
   * What to do when a second session registers under a name a live session already
   * holds. `reject` (default) keeps the incumbent and rejects the newcomer (with a
   * room notice); `replace` restores the old take-over behavior. A dead/half-open
   * incumbent is always taken over regardless, so a genuine restart still attaches.
   */
  duplicateName: z.enum(["reject", "replace"]).default("reject"),
  /**
   * Where hub-wide notices (presence, duplicate-registration) go: `dm` to admins'
   * DMs (works with no group configured), `rooms` to `HUB_ROOMS`, or `both`.
   * Defaults to `dm` so notices reach the operator regardless of group setup.
   */
  notify: z.enum(["dm", "rooms", "both"]).default("dm"),
  /**
   * Admin user ids permitted to run in-chat allowlist commands (`/allow`, …).
   * Empty means "fall back to the allowlist seed" (resolved by the hub).
   */
  admins: z.array(z.string().min(1)).default([]),
  /**
   * Path to a JSON file that persists runtime allowlist changes across restarts.
   * Unset = in-memory only (changes are lost on restart).
   */
  stateFile: z.string().min(1).optional(),
  /**
   * Route an unknown sender into a `pending` queue (and notify admins) instead of
   * dropping them silently, so access can be granted with `/allow`. Off by default.
   */
  pairing: z.boolean().default(false),
  /**
   * Speech-to-text service base URL (OpenAI-compatible, exposes
   * `POST /v1/audio/transcriptions`). Unset = voice transcription disabled.
   */
  sttUrl: z.string().url().optional(),
  /** STT model name passed to the service (e.g. `small`, `medium`). */
  sttModel: z.string().min(1).default("small"),
  /** STT language: `auto` (detect) or an ISO code such as `ru` / `en`. */
  sttLang: z.string().min(1).default("auto"),
  /** API key for a cloud STT service (sent as `Authorization: Bearer …` by default). */
  sttApiKey: z.string().min(1).optional(),
  /** STT auth header name; override to `api-key` for Azure OpenAI. */
  sttAuthHeader: z.string().min(1).optional(),
  /** Echo a voice note's transcript (and resolved recipients) into the room. */
  voiceEcho: z.boolean().default(true),
  /**
   * Text-to-speech service base URL (OpenAI-compatible, exposes
   * `POST /v1/audio/speech`). Unset = agents can't reply with voice.
   */
  ttsUrl: z.string().url().optional(),
  /** TTS model id (server-specific). Required when `ttsUrl` is set. */
  ttsModel: z.string().min(1).optional(),
  /** TTS voice id (language-specific). Required when `ttsUrl` is set. */
  ttsVoice: z.string().min(1).optional(),
  /** TTS response format; `opus` → OGG/Opus (a Telegram voice note). */
  ttsFormat: z.string().min(1).default("opus"),
  /** API key for a cloud TTS service (sent as `Authorization: Bearer …` by default). */
  ttsApiKey: z.string().min(1).optional(),
  /** TTS auth header name; override to `api-key` for Azure OpenAI. */
  ttsAuthHeader: z.string().min(1).optional(),
  /** Skip voicing a reply whose speakable text exceeds this many characters. */
  ttsMaxChars: z.number().int().positive().default(300),
  /** Token that marks an agent mention. */
  tagSigil: z.string().min(1).default("@"),
  /** Address the session-facing WS/HTTP server binds to. */
  bindHost: z.string().min(1).default("127.0.0.1"),
  // 0 is allowed: bind an OS-assigned ephemeral port (handy in tests/containers).
  bindPort: z.number().int().min(0).max(65535).default(8787),
  /**
   * Interval (ms) between WebSocket keepalive pings to each session. Keeps the
   * connection warm under a reverse proxy's idle timeout (Azure Container Apps
   * ~240s, nginx 60s, Cloudflare ~100s) so quiet sessions aren't reaped and
   * presence doesn't flap. `0` disables it (fine for a co-located hub). Default 30s.
   */
  keepaliveMs: z.number().int().nonnegative().default(30000),
  /** Which transport adapter to load. */
  adapter: z.string().min(1).default("telegram"),
  logLevel: logLevelSchema.default("info"),
})
  .refine((c) => c.answerSlaMs > c.ackSlaMs, {
    message: "answerSlaMs (HUB_ANSWER_SLA) must be greater than ackSlaMs (HUB_ACK_SLA)",
    path: ["answerSlaMs"],
  })
  .refine((c) => !c.ttsUrl || (c.ttsModel !== undefined && c.ttsVoice !== undefined), {
    message: "HUB_TTS_MODEL and HUB_TTS_VOICE are required when HUB_TTS_URL is set",
    path: ["ttsModel"],
  });
export type HubConfig = z.infer<typeof hubConfigSchema>;

/** Env var names for hub-core config (single source of truth for docs + loader). */
export const HUB_ENV = {
  sessionSecret: "HUB_SESSION_SECRET",
  allowlist: "HUB_ALLOWLIST",
  rooms: "HUB_ROOMS",
  hopBudget: "HUB_HOP_BUDGET",
  broadcast: "HUB_BROADCAST",
  presence: "HUB_PRESENCE",
  presenceGraceMs: "HUB_PRESENCE_GRACE_MS",
  sla: "HUB_SLA",
  ackSlaMs: "HUB_ACK_SLA",
  answerSlaMs: "HUB_ANSWER_SLA",
  duplicateName: "HUB_DUPLICATE_NAME",
  notify: "HUB_NOTIFY",
  admins: "HUB_ADMINS",
  stateFile: "HUB_STATE_FILE",
  pairing: "HUB_PAIRING",
  sttUrl: "HUB_STT_URL",
  sttModel: "HUB_STT_MODEL",
  sttLang: "HUB_STT_LANG",
  sttApiKey: "HUB_STT_API_KEY",
  sttAuthHeader: "HUB_STT_AUTH_HEADER",
  voiceEcho: "HUB_VOICE_ECHO",
  ttsUrl: "HUB_TTS_URL",
  ttsModel: "HUB_TTS_MODEL",
  ttsVoice: "HUB_TTS_VOICE",
  ttsFormat: "HUB_TTS_FORMAT",
  ttsMaxChars: "HUB_TTS_MAX_CHARS",
  ttsApiKey: "HUB_TTS_API_KEY",
  ttsAuthHeader: "HUB_TTS_AUTH_HEADER",
  tagSigil: "HUB_TAG_SIGIL",
  bindHost: "HUB_BIND_HOST",
  bindPort: "HUB_BIND_PORT",
  keepaliveMs: "HUB_KEEPALIVE_MS",
  adapter: "HUB_ADAPTER",
  logLevel: "HUB_LOG_LEVEL",
} as const;

export function loadHubConfig(env: Env): HubConfig {
  return parseOrThrow(
    hubConfigSchema,
    {
      sessionSecret: env[HUB_ENV.sessionSecret],
      allowlist: csv(env[HUB_ENV.allowlist]),
      rooms: csv(env[HUB_ENV.rooms]),
      hopBudget: num(env[HUB_ENV.hopBudget]),
      broadcast: bool(env[HUB_ENV.broadcast]),
      presence: bool(env[HUB_ENV.presence]),
      presenceGraceMs: num(env[HUB_ENV.presenceGraceMs]),
      sla: bool(env[HUB_ENV.sla]),
      ackSlaMs: num(env[HUB_ENV.ackSlaMs]),
      answerSlaMs: num(env[HUB_ENV.answerSlaMs]),
      duplicateName: env[HUB_ENV.duplicateName],
      notify: env[HUB_ENV.notify],
      admins: csv(env[HUB_ENV.admins]),
      stateFile: env[HUB_ENV.stateFile],
      pairing: bool(env[HUB_ENV.pairing]),
      sttUrl: env[HUB_ENV.sttUrl],
      sttModel: env[HUB_ENV.sttModel],
      sttLang: env[HUB_ENV.sttLang],
      sttApiKey: env[HUB_ENV.sttApiKey],
      sttAuthHeader: env[HUB_ENV.sttAuthHeader],
      voiceEcho: bool(env[HUB_ENV.voiceEcho]),
      ttsUrl: env[HUB_ENV.ttsUrl],
      ttsModel: env[HUB_ENV.ttsModel],
      ttsVoice: env[HUB_ENV.ttsVoice],
      ttsFormat: env[HUB_ENV.ttsFormat],
      ttsMaxChars: num(env[HUB_ENV.ttsMaxChars]),
      ttsApiKey: env[HUB_ENV.ttsApiKey],
      ttsAuthHeader: env[HUB_ENV.ttsAuthHeader],
      tagSigil: env[HUB_ENV.tagSigil],
      bindHost: env[HUB_ENV.bindHost],
      bindPort: num(env[HUB_ENV.bindPort]),
      keepaliveMs: num(env[HUB_ENV.keepaliveMs]),
      adapter: env[HUB_ENV.adapter],
      logLevel: env[HUB_ENV.logLevel],
    },
    "hub",
  );
}

// ── telegram adapter (platform-specific) ──────────────────────────────────────

export const telegramAdapterConfigSchema = z.object({
  /** The single Telegram bot token the hub authenticates as. */
  botToken: z.string().min(1),
});
export type TelegramAdapterConfig = z.infer<typeof telegramAdapterConfigSchema>;

export const TELEGRAM_ADAPTER_ENV = {
  botToken: "TELEGRAM_BOT_TOKEN",
} as const;

export function loadTelegramAdapterConfig(env: Env): TelegramAdapterConfig {
  return parseOrThrow(
    telegramAdapterConfigSchema,
    { botToken: env[TELEGRAM_ADAPTER_ENV.botToken] },
    "telegram adapter",
  );
}

// ── thin channel ──────────────────────────────────────────────────────────────

export const channelConfigSchema = z.object({
  /** Hub URL the session connects to; local or remote (e.g. ws://host:8787). */
  hubUrl: z.string().url(),
  /** Shared secret; must match the hub's `sessionSecret`. */
  sessionSecret: z.string().min(1),
  /** This session's agent name; defaults to the working-dir basename. */
  agent: z.string().min(1),
  logLevel: logLevelSchema.default("info"),
  /** Reconnect backoff bounds for the hub link. */
  reconnectInitialMs: z.number().int().positive().default(500),
  reconnectMaxMs: z.number().int().positive().default(15000),
  /** Max size (MB) of a file this session will send out through the hub. */
  maxFileMb: z.number().int().positive().default(50),
});
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export const CHANNEL_ENV = {
  hubUrl: "TELEGRAM_HUB_URL",
  sessionSecret: "TELEGRAM_HUB_SECRET",
  agent: "TELEGRAM_HUB_AGENT",
  logLevel: "TELEGRAM_HUB_LOG_LEVEL",
  reconnectInitialMs: "TELEGRAM_HUB_RECONNECT_INITIAL_MS",
  reconnectMaxMs: "TELEGRAM_HUB_RECONNECT_MAX_MS",
  maxFileMb: "TELEGRAM_HUB_MAX_FILE_MB",
} as const;

/**
 * One layer of channel config. A single installed plugin attaches different
 * sessions to different hubs, so config resolves per-session from ordered
 * layers: env (per-repo) > repo file > machine defaults. Earlier layers win.
 */
export type ChannelConfigLayer = Partial<
  Record<keyof ChannelConfig, string | undefined>
>;

/** Build a channel config layer from an env map. */
export function channelEnvLayer(env: Env): ChannelConfigLayer {
  return {
    hubUrl: env[CHANNEL_ENV.hubUrl],
    sessionSecret: env[CHANNEL_ENV.sessionSecret],
    agent: env[CHANNEL_ENV.agent],
    logLevel: env[CHANNEL_ENV.logLevel],
    reconnectInitialMs: env[CHANNEL_ENV.reconnectInitialMs],
    reconnectMaxMs: env[CHANNEL_ENV.reconnectMaxMs],
    maxFileMb: env[CHANNEL_ENV.maxFileMb],
  };
}

/**
 * Resolve final channel config from ordered layers (earlier wins), falling back
 * to `agentFallback` (the working-dir basename) when no layer supplies an agent.
 */
export function resolveChannelConfig(
  layers: ChannelConfigLayer[],
  opts: { agentFallback?: string } = {},
): ChannelConfig {
  const pick = (key: keyof ChannelConfig): string | undefined => {
    for (const layer of layers) {
      const v = layer[key];
      if (v !== undefined && v !== "") return v;
    }
    return undefined;
  };
  return parseOrThrow(
    channelConfigSchema,
    {
      hubUrl: pick("hubUrl"),
      sessionSecret: pick("sessionSecret"),
      agent: pick("agent") ?? opts.agentFallback,
      logLevel: pick("logLevel"),
      reconnectInitialMs: num(pick("reconnectInitialMs")),
      reconnectMaxMs: num(pick("reconnectMaxMs")),
      maxFileMb: num(pick("maxFileMb")),
    },
    "channel",
  );
}
