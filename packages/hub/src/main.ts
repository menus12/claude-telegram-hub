#!/usr/bin/env node
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import { Hub } from "./hub.js";
import { LoopbackAdapter } from "./adapters/loopback.js";
import { makeLogger } from "./logger.js";
import type { TransportAdapter } from "./adapter.js";

/** Select the transport adapter by name. Telegram lands in Stage 3. */
function buildAdapter(name: string): TransportAdapter {
  switch (name) {
    case "loopback":
      return new LoopbackAdapter();
    default:
      throw new Error(
        `adapter "${name}" is not available yet (set HUB_ADAPTER=loopback for now)`,
      );
  }
}

async function main(): Promise<void> {
  const cfg = loadHubConfig(process.env);
  const log = makeLogger(cfg.logLevel);
  const adapter = buildAdapter(cfg.adapter);
  const hub = new Hub({ config: cfg, adapter, logger: log });

  const shutdown = (): void => {
    void hub.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await hub.start();
}

void main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
