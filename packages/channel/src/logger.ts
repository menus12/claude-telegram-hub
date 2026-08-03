import type { LogLevel } from "@claude-telegram-hub/protocol";

export type Logger = (
  level: LogLevel,
  msg: string,
  meta?: Record<string, unknown>,
) => void;

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Structured logger. Writes JSON lines to **stderr** — never stdout, which is
 * the MCP stdio transport and must carry only protocol traffic. A stray write
 * to stdout would corrupt the channel.
 */
export function makeLogger(min: LogLevel): Logger {
  return (level, msg, meta) => {
    if (ORDER[level] < ORDER[min]) return;
    const record = { time: new Date().toISOString(), level, msg, ...meta };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  };
}
