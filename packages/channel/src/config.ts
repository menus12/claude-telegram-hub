import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  channelConfigSchema,
  channelEnvLayer,
  hubEntrySchema,
  resolveChannelConfig,
  type ChannelConfig,
  type ChannelConfigLayer,
  type LabeledChannelConfig,
} from "@claude-telegram-hub/protocol";

const REPO_CONFIG_FILE = ".telegram-hub.json";

type Env = Record<string, string | undefined>;

/**
 * Read a JSON config file into a channel config layer. An absent file is an
 * empty layer (silent); a present-but-broken file fails loudly.
 */
function fileLayer(path: string): ChannelConfigLayer {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read channel config file ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in channel config file ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Channel config file ${path} must contain a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    v === undefined || v === null ? undefined : String(v);
  return {
    hubUrl: str(obj.hubUrl),
    sessionSecret: str(obj.sessionSecret),
    agent: str(obj.agent),
    logLevel: str(obj.logLevel),
    reconnectInitialMs: str(obj.reconnectInitialMs),
    reconnectMaxMs: str(obj.reconnectMaxMs),
  };
}

/** Read a JSON config file into its raw object, or undefined if absent. Throws on broken JSON. */
function fileRaw(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read channel config file ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in channel config file ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Channel config file ${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Machine-wide defaults file, honoring XDG_CONFIG_HOME then ~/.config. */
function machineConfigPath(env: Env): string | undefined {
  const dir =
    env.XDG_CONFIG_HOME ?? (env.HOME ? join(env.HOME, ".config") : undefined);
  return dir ? join(dir, "claude-telegram-hub", "config.json") : undefined;
}

export interface LoadOptions {
  env?: Env;
  cwd?: string;
}

/**
 * Resolve channel config for this session. A single installed plugin attaches
 * different sessions to different hubs, so config resolves per session from
 * ordered layers (earlier wins):
 *
 *   env (per-repo) > repo file (.telegram-hub.json) > machine defaults
 *
 * with the agent name falling back to the working-directory basename.
 */
export function loadChannelConfig(opts: LoadOptions = {}): ChannelConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const machinePath = machineConfigPath(env);
  const layers: ChannelConfigLayer[] = [
    channelEnvLayer(env),
    fileLayer(join(cwd, REPO_CONFIG_FILE)),
    ...(machinePath ? [fileLayer(machinePath)] : []),
  ];
  return resolveChannelConfig(layers, { agentFallback: basename(cwd) });
}

const num = (v: unknown): number | string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
};
const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

function asHubsArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) && v.length > 0 ? v : undefined;
}

/**
 * Resolve one or more hub connections for this session. When a config file (repo
 * `.telegram-hub.json` wins, else machine config) carries a `hubs` array, the
 * session attaches to **each** hub — namespaced by its `label` — so one agent can
 * participate in several project rooms and tell `learn/kb` from `cheburnet/kb`.
 * Otherwise it resolves the single hub exactly as before (a 1-element list, label
 * defaulting to the agent name), so existing single-hub setups are unaffected.
 */
export function loadChannelConfigs(opts: LoadOptions = {}): LabeledChannelConfig[] {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const machinePath = machineConfigPath(env);

  const repoRaw = fileRaw(join(cwd, REPO_CONFIG_FILE));
  const machineRaw = machinePath ? fileRaw(machinePath) : undefined;
  const hubs = asHubsArray(repoRaw?.hubs) ?? asHubsArray(machineRaw?.hubs);

  if (!hubs) {
    // Single-hub: unchanged resolution; the label is just the agent name.
    const single = loadChannelConfig(opts);
    return [{ ...single, label: single.agent }];
  }

  // Shared (non-connection) fields resolve env > the file that supplied `hubs` > defaults.
  const shared: Record<string, unknown> = asHubsArray(repoRaw?.hubs) ? (repoRaw ?? {}) : (machineRaw ?? {});
  const pickShared = (key: keyof ChannelConfig): unknown => {
    const e = channelEnvLayer(env)[key];
    return e !== undefined && e !== "" ? e : shared[key];
  };

  const labeled = hubs.map((entry, i) => {
    const parsed = hubEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`hubs[${i}] is invalid: ${parsed.error.issues.map((x) => x.message).join("; ")}`);
    }
    const cfg = channelConfigSchema.parse({
      hubUrl: parsed.data.hubUrl,
      sessionSecret: parsed.data.sessionSecret,
      agent: parsed.data.agent,
      logLevel: str(pickShared("logLevel")),
      reconnectInitialMs: num(pickShared("reconnectInitialMs")),
      reconnectMaxMs: num(pickShared("reconnectMaxMs")),
      maxFileMb: num(pickShared("maxFileMb")),
    });
    return { ...cfg, label: parsed.data.label };
  });

  const labels = new Set<string>();
  for (const h of labeled) {
    if (labels.has(h.label)) throw new Error(`duplicate hub label "${h.label}" — labels must be unique`);
    labels.add(h.label);
  }
  return labeled;
}
