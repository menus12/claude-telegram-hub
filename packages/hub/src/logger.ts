import type { LogLevel } from "@claude-telegram-hub/protocol";

export type Logger = (
  level: LogLevel,
  msg: string,
  meta?: Record<string, unknown>,
) => void;

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Structured logger for the hub. Unlike the channel (whose stdout is an MCP
 * transport), the hub is a plain service, so it logs JSON lines to stdout.
 */
export function makeLogger(min: LogLevel): Logger {
  return (level, msg, meta) => {
    if (ORDER[level] < ORDER[min]) return;
    const record = { time: new Date().toISOString(), level, msg, ...meta };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };
}
