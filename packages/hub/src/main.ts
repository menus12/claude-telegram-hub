#!/usr/bin/env node
import { loadHubConfig, loadTelegramAdapterConfig } from "@claude-telegram-hub/protocol";
import type { HubConfig } from "@claude-telegram-hub/protocol";
import { Hub } from "./hub.js";
import { LoopbackAdapter } from "./adapters/loopback.js";
import { GrammyApi } from "./adapters/telegram/grammy-api.js";
import { TelegramAdapter } from "./adapters/telegram/adapter.js";
import { HttpTranscriptionService } from "./transcription.js";
import { HttpSynthesisService } from "./synthesis.js";
import { makeLogger, type Logger } from "./logger.js";
import type { TransportAdapter } from "./adapter.js";

/** Select the transport adapter by name. */
function buildAdapter(
  cfg: HubConfig,
  env: NodeJS.ProcessEnv,
  log: Logger,
): TransportAdapter {
  switch (cfg.adapter) {
    case "loopback":
      return new LoopbackAdapter();
    case "telegram": {
      const tg = loadTelegramAdapterConfig(env);
      // Voice transcription is enabled by pointing HUB_STT_URL at an STT service.
      const transcriber = cfg.sttUrl
        ? new HttpTranscriptionService({
            url: cfg.sttUrl,
            model: cfg.sttModel,
            defaultLang: cfg.sttLang,
            logger: log,
          })
        : undefined;
      return new TelegramAdapter({
        api: new GrammyApi(tg.botToken, log),
        tagSigil: cfg.tagSigil,
        logger: log,
        ...(transcriber ? { transcriber } : {}),
      });
    }
    default:
      throw new Error(`unknown adapter "${cfg.adapter}"`);
  }
}

async function main(): Promise<void> {
  const cfg = loadHubConfig(process.env);
  const log = makeLogger(cfg.logLevel);
  const adapter = buildAdapter(cfg, process.env, log);
  // Text-to-speech (voiced replies) is enabled by pointing HUB_TTS_URL at a service;
  // config validation guarantees model + voice are present when the URL is set.
  const synth =
    cfg.ttsUrl && cfg.ttsModel && cfg.ttsVoice
      ? new HttpSynthesisService({
          url: cfg.ttsUrl,
          model: cfg.ttsModel,
          voice: cfg.ttsVoice,
          format: cfg.ttsFormat,
          logger: log,
        })
      : undefined;
  const hub = new Hub({ config: cfg, adapter, logger: log, ...(synth ? { synth } : {}) });

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
