#!/usr/bin/env node
import { buildChannel } from "./channel.js";
import { loadChannelConfigs } from "./config.js";
import { makeLogger } from "./logger.js";

/**
 * Entrypoint Claude Code spawns over stdio for `--channels plugin:telegram-hub`.
 * Resolves config, wires the channel, and keeps the process alive for the
 * session's lifetime. All diagnostics go to stderr; stdout is the MCP transport.
 */
async function main(): Promise<void> {
  let hubs;
  try {
    hubs = loadChannelConfigs();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const log = makeLogger(hubs[0].logLevel);
  const channel = buildChannel(hubs, { logger: log });

  const shutdown = (): void => {
    void channel.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await channel.start();
}

void main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
