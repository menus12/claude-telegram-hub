# @claude-telegram-hub/hub

The always-on **hub**: the single owner of the platform transport. It runs the session-facing
WS/HTTP server, the agent registry, `@tag` routing, the allowlist, and (later) the loop governor.
The core is **adapter-agnostic** — transports plug in behind one `TransportAdapter` interface
(`loopback` for dev/test now; `telegram` in Stage 3).

## What's implemented

- **Session server** — HTTP + WebSocket on one port. Register handshake with protocol-version
  check and **constant-time secret auth**; reply intake; `GET /healthz` and `GET /readyz` for
  orchestration.
- **Agent registry** — `agent name ↔ live session`; a restarting session re-attaches and
  displaces its old connection without disturbing other agents.
- **Routing** — explicit-mention-only delivery to connected agents; allowlist enforced on human
  senders; a session's reply is sent back to its room via the adapter.
- **Adapters** — `loopback` (in-memory, for dev/test) and `telegram` (grammY long-poll). The core
  is adapter-agnostic; both implement the one `TransportAdapter` interface.

Group routing + agent↔agent re-injection (Stage 4) and the loop governor (Stage 5) build on this.

## Run (development)

```sh
npm run build -w @claude-telegram-hub/hub
# loopback (no external service):
HUB_SESSION_SECRET=secret HUB_ALLOWLIST=123456789 HUB_ADAPTER=loopback \
  node packages/hub/dist/main.js
# telegram:
HUB_SESSION_SECRET=secret HUB_ALLOWLIST=123456789 HUB_ADAPTER=telegram \
  TELEGRAM_BOT_TOKEN=123456:ABC… node packages/hub/dist/main.js
# health:
curl localhost:8787/healthz   # -> ok
curl localhost:8787/readyz    # -> ready
```

A Stage 1 channel then attaches with `TELEGRAM_HUB_URL=ws://127.0.0.1:8787` and the same secret.

## Telegram setup

- **Bot token** — create a bot via [@BotFather](https://t.me/BotFather); pass it as
  `TELEGRAM_BOT_TOKEN`. One token, one hub process — grammY runs the single `getUpdates`
  long-poll, so **exactly one process owns the transport**. Never run a second poller on the
  same token.
- **Groups need admin / privacy off** — by default a bot in a group only receives `@mentions`,
  replies, and commands. Make the hub bot a **group admin** (which disables privacy mode) so it
  receives every message and can route by tag. Privacy changes require re-adding the bot.
- **DMs** — the bot receives DMs directly. A DM is routed by the **same explicit `@tag`** path as
  a group (`@re-infra …`); the reply returns to that DM.
- **Allowlist** — set `HUB_ALLOWLIST` to the numeric Telegram user ids permitted to reach the
  hub; everyone else is dropped.

> Automated tests mock the Bot API (no live token in CI). To try it for real, use a BotFather
> token, add the bot to a group as admin, and DM or tag it.

## Configuration

All config is env-only — see [`.env.example`](.env.example) and the full contract in
[docs/configuration.md](../../docs/configuration.md). Every deployment-varying value is a named,
validated input; the same image runs everywhere, only the environment differs.

> For a container/remote hub set `HUB_BIND_HOST=0.0.0.0` and front it with auth/TLS. Containerized
> packaging (Docker/ACI) is finalized in Stage 6.
