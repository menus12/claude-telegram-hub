#!/usr/bin/env node
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { makeLogger } from "@claude-telegram-hub/channel";
import { loadBridgeConfig } from "./config.js";
import { BridgeServer } from "./server.js";
import { TokenStore, parseTokens } from "./tokens.js";

// Node 18 has no global `crypto`, which the MCP SDK expects.
if (!globalThis.crypto) Object.assign(globalThis, { crypto: webcrypto });

/**
 * Entrypoint for the cloud bridge. Resolves config from the environment, loads the
 * hashed per-environment tokens, and serves remote MCP until SIGINT/SIGTERM, when
 * every cloud agent leaves (with a room notice) before the process exits.
 */
async function main(): Promise<void> {
  let config;
  let tokens;
  try {
    config = loadBridgeConfig(process.env);
    tokens = new TokenStore(parseTokens(readFileSync(config.tokensFile, "utf8")));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = makeLogger(config.logLevel);
  const bridge = new BridgeServer({ config, tokens, logger });

  const shutdown = (): void => {
    void bridge.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bridge.start();
}

void main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
