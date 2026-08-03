import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  channelEnvLayer,
  resolveChannelConfig,
  type ChannelConfig,
  type ChannelConfigLayer,
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
