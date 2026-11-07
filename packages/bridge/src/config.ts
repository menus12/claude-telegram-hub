import { z } from "zod";
import { logLevelSchema } from "@claude-telegram-hub/protocol";

type Env = Record<string, string | undefined>;

/**
 * Bridge configuration. Like the hub and channel, every deployment-varying value is
 * a named, validated env input. The bridge holds the hub session secret (it is a
 * protocol client, like the channel); cloud sessions never see it — they
 * authenticate to the bridge with a per-environment bearer (see tokens.ts).
 */
export const bridgeConfigSchema = z.object({
  /** Hub session-facing URL the bridge registers cloud agents with. */
  hubUrl: z.string().url(),
  /** The hub's session secret (stays on the box). */
  sessionSecret: z.string().min(1),
  bindHost: z.string().min(1).default("127.0.0.1"),
  bindPort: z.number().int().min(0).max(65535).default(8788),
  /** File of `label sha256hex` lines: the accepted per-environment bearer tokens, hashed. */
  tokensFile: z.string().min(1),
  /** Room for join/leave notices and for a `send` before any inbound arrived. */
  defaultRoom: z.string().min(1),
  /** Every cloud agent name carries this prefix, so local agents' names can't be taken. */
  agentPrefix: z.string().regex(/^[a-z0-9-]+$/).default("cloud-"),
  /** An agent with no pending `wait` and no tool call for this long is auto-left. */
  ttlMs: z.number().int().positive().default(15 * 60_000),
  /** Upper bound for one `wait`; must stay below the client's per-server MCP timeout (900 s). */
  waitMaxS: z.number().int().positive().max(3600).default(840),
  /** Progress cadence during `wait` — the keepalive under Cloudflare's ~100 s origin limit. */
  progressEveryS: z.number().int().positive().default(20),
  /** Per-agent inbound queue bound (drop-oldest beyond it). */
  queueMax: z.number().int().positive().default(50),
  /** How long `join` waits for the hub to accept a registration. */
  joinTimeoutMs: z.number().int().positive().default(10_000),
  /** Authenticated HTTP requests per minute, per token. */
  requestsPerMin: z.number().int().positive().default(120),
  /** Live cloud agents one token (one cloud environment) may hold at once. */
  maxAgentsPerToken: z.number().int().positive().default(5),
  /** `send` calls per minute, per agent (protects the room). */
  sendsPerMin: z.number().int().positive().default(10),
  /** Unauthenticated requests per minute, per client IP, before 429. */
  unauthPerMin: z.number().int().positive().default(10),
  /** Max request body size. */
  maxBodyBytes: z.number().int().positive().default(64 * 1024),
  logLevel: logLevelSchema.default("info"),
});
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

export const BRIDGE_ENV = {
  hubUrl: "BRIDGE_HUB_URL",
  sessionSecret: "BRIDGE_HUB_SECRET",
  bindHost: "BRIDGE_BIND_HOST",
  bindPort: "BRIDGE_BIND_PORT",
  tokensFile: "BRIDGE_TOKENS_FILE",
  defaultRoom: "BRIDGE_DEFAULT_ROOM",
  agentPrefix: "BRIDGE_AGENT_PREFIX",
  ttlMs: "BRIDGE_TTL_MS",
  waitMaxS: "BRIDGE_WAIT_MAX_S",
  progressEveryS: "BRIDGE_PROGRESS_EVERY_S",
  queueMax: "BRIDGE_QUEUE_MAX",
  joinTimeoutMs: "BRIDGE_JOIN_TIMEOUT_MS",
  requestsPerMin: "BRIDGE_REQUESTS_PER_MIN",
  maxAgentsPerToken: "BRIDGE_MAX_AGENTS_PER_TOKEN",
  sendsPerMin: "BRIDGE_SENDS_PER_MIN",
  unauthPerMin: "BRIDGE_UNAUTH_PER_MIN",
  maxBodyBytes: "BRIDGE_MAX_BODY_BYTES",
  logLevel: "BRIDGE_LOG_LEVEL",
} as const satisfies Record<keyof BridgeConfig, string>;

const NUMERIC = new Set<keyof BridgeConfig>([
  "bindPort",
  "ttlMs",
  "waitMaxS",
  "progressEveryS",
  "queueMax",
  "joinTimeoutMs",
  "requestsPerMin",
  "maxAgentsPerToken",
  "sendsPerMin",
  "unauthPerMin",
  "maxBodyBytes",
]);

/** Blank → undefined (schema default); numeric strings → numbers; else passed through for a clear error. */
function coerce(key: keyof BridgeConfig, v: string | undefined): unknown {
  if (v === undefined || v.trim() === "") return undefined;
  if (!NUMERIC.has(key)) return v.trim();
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : v;
}

export function loadBridgeConfig(env: Env): BridgeConfig {
  const input: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(BRIDGE_ENV) as [keyof BridgeConfig, string][]) {
    input[key] = coerce(key, env[name]);
  }
  const result = bridgeConfigSchema.safeParse(input);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => {
    const key = i.path[0] as keyof BridgeConfig | undefined;
    return `  - ${key ? BRIDGE_ENV[key] : "(root)"}: ${i.message}`;
  });
  throw new Error(`Invalid bridge configuration:\n${lines.join("\n")}`);
}
