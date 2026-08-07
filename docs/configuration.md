# Configuration

Both artifacts are **identical across deployments** — the hub image and the channel package are
the same everywhere; only the environment differs. Every deployment-varying value is a named,
validated, documented input, defined once as a Zod schema in `packages/protocol` (no literals in
code, hard failure on a missing required value). Loaders take an explicit `env` map, so they are
pure and testable.

All values come from the environment (or a gitignored `.env`). **Never commit secrets.**

## Hub (core) — `loadHubConfig(env)`

Transport-agnostic. The hub image reads these regardless of which adapter is active.

| Env var | Type | Default | Purpose |
|---------|------|---------|---------|
| `HUB_SESSION_SECRET` | string | — (**required**) | Shared secret a session must present to register. |
| `HUB_ALLOWLIST` | csv | — (**required**, ≥1) | Platform user ids allowed to talk to the hub; unknown senders dropped. |
| `HUB_ROOMS` | csv | `[]` | Group room ids the hub operates in. Empty is valid (DM-only). |
| `HUB_HOP_BUDGET` | int | `6` | Coordination-thread hops before agent→agent routing freezes. |
| `HUB_PRESENCE` | bool | `false` | Announce `@agent online/offline` in `HUB_ROOMS`. Opt-in; needs ≥1 room. Accepts `on/off`, `true/false`, `1/0`, `yes/no`. |
| `HUB_PRESENCE_GRACE_MS` | int | `10000` | Grace window a dropped session may reconnect within before it's announced offline (absorbs restart churn). |
| `HUB_SLA` | bool | `false` | Durable response-SLA backstop for unanswered agent→agent `@`-asks. Opt-in. |
| `HUB_ACK_SLA` | int | `120000` | T1 — silence (ms) before the hub nudges the peer once. |
| `HUB_ANSWER_SLA` | int | `600000` | T2 — silence (ms) before the hub escalates to the operator and unblocks the asker. Must be > `HUB_ACK_SLA`. |
| `HUB_TAG_SIGIL` | string | `@` | Token that marks an agent mention. |
| `HUB_BIND_HOST` | string | `127.0.0.1` | Address the session-facing WS/HTTP server binds to. |
| `HUB_BIND_PORT` | int (0–65535) | `8787` | Port for the session-facing server (`0` = OS-assigned ephemeral). |
| `HUB_ADAPTER` | string | `telegram` | Which transport adapter to load. |
| `HUB_LOG_LEVEL` | enum | `info` | `debug` \| `info` \| `warn` \| `error`. |

> A container/remote hub must bind an externally reachable interface — set `HUB_BIND_HOST=0.0.0.0`
> and put auth/TLS in front of it. `127.0.0.1` is the safe default for a co-located hub.

## Telegram adapter — `loadTelegramAdapterConfig(env)`

Platform-specific; kept separate so the hub core stays adapter-agnostic.

| Env var | Type | Default | Purpose |
|---------|------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | string | — (**required**) | The single Telegram bot the hub authenticates as. |

## Channel (thin plugin) — `resolveChannelConfig(layers, { agentFallback })`

One installed plugin attaches **different sessions to different hubs**, so config resolves
**per session** from ordered layers — **earlier wins**:

```
env (per-repo)  >  repo file (.telegram-hub.json)  >  machine defaults  >  agent = cwd basename
```

`channelEnvLayer(env)` builds the env layer; `resolveChannelConfig` merges the layers and falls
back to `agentFallback` (the working-dir basename) when no layer supplies an agent.

| Env var | Type | Default | Purpose |
|---------|------|---------|---------|
| `TELEGRAM_HUB_URL` | url | — (**required**) | Hub URL the session connects to (local or remote). |
| `TELEGRAM_HUB_SECRET` | string | — (**required**) | Shared secret; must equal the hub's `HUB_SESSION_SECRET`. |
| `TELEGRAM_HUB_AGENT` | string | cwd basename | This session's agent name. |
| `TELEGRAM_HUB_LOG_LEVEL` | enum | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `TELEGRAM_HUB_RECONNECT_INITIAL_MS` | int | `500` | Initial reconnect backoff for the hub link. |
| `TELEGRAM_HUB_RECONNECT_MAX_MS` | int | `15000` | Maximum reconnect backoff. |

> `TELEGRAM_HUB_SECRET` and `HUB_SESSION_SECRET` are the **same secret** viewed from the two
> sides. Keep them in sync per deployment.

## Notes

- Actual `.env.example` files and the file-layer / basename resolution wiring land with the hub
  (Stage 2) and channel (Stage 1); this page documents the contract they implement.
- The env-var **names** are the single source of truth in `config.ts` (`HUB_ENV`,
  `TELEGRAM_ADAPTER_ENV`, `CHANNEL_ENV`) — this table mirrors them.
