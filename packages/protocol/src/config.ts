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
  /** Token that marks an agent mention. */
  tagSigil: z.string().min(1).default("@"),
  /** Address the session-facing WS/HTTP server binds to. */
  bindHost: z.string().min(1).default("127.0.0.1"),
  bindPort: z.number().int().min(1).max(65535).default(8787),
  /** Which transport adapter to load. */
  adapter: z.string().min(1).default("telegram"),
  logLevel: logLevelSchema.default("info"),
});
export type HubConfig = z.infer<typeof hubConfigSchema>;

/** Env var names for hub-core config (single source of truth for docs + loader). */
export const HUB_ENV = {
  sessionSecret: "HUB_SESSION_SECRET",
  allowlist: "HUB_ALLOWLIST",
  rooms: "HUB_ROOMS",
  hopBudget: "HUB_HOP_BUDGET",
  tagSigil: "HUB_TAG_SIGIL",
  bindHost: "HUB_BIND_HOST",
  bindPort: "HUB_BIND_PORT",
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
      tagSigil: env[HUB_ENV.tagSigil],
      bindHost: env[HUB_ENV.bindHost],
      bindPort: num(env[HUB_ENV.bindPort]),
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
});
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export const CHANNEL_ENV = {
  hubUrl: "TELEGRAM_HUB_URL",
  sessionSecret: "TELEGRAM_HUB_SECRET",
  agent: "TELEGRAM_HUB_AGENT",
  logLevel: "TELEGRAM_HUB_LOG_LEVEL",
  reconnectInitialMs: "TELEGRAM_HUB_RECONNECT_INITIAL_MS",
  reconnectMaxMs: "TELEGRAM_HUB_RECONNECT_MAX_MS",
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
    },
    "channel",
  );
}
