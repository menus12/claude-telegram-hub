# claude-telegram-hub

Drive interactive **Claude Code** sessions from **Telegram** — DM a session, or run a shared
group room where several repo-scoped Claude instances coordinate with each other, with a
human in the loop.

The hub keeps Claude exactly as it already runs — **interactive sessions on your own machine,
your own subscription, live in each repo**. It only owns the *transport*: one always-on
service authenticates to Telegram, and each Claude session attaches to it through a thin
Claude Code *channel*. Transport adapters are pluggable (Telegram today; Microsoft Teams /
Slack are future adapters behind the same interface).

> **Status: v1 implemented.** The protocol/config contract, the thin channel, the hub core, the
> Telegram adapter, group routing + agent↔agent coordination, and the loop governor are all built
> and CI-tested (milestones in issue #1). Run it with `docker compose up` or the deploys below.

## Why not the built-in channel plugins?

Claude Code's built-in channel plugins bridge one bot to one session by having each session
long-poll the chat platform itself. That's fine for a single DM but fragile at scale — one
poller per token, no auto-restart, shared-state footguns — and it structurally can't do two
things this project needs:

- **Inbound-webhook transports** (Microsoft Teams): an ephemeral session has no stable public
  URL to receive webhooks. A central, always-on hub does.
- **Multi-agent coordination**: chat platforms don't deliver one bot's messages to another
  bot, so independent sessions can't hear each other. A hub is the shared bus that relays
  agent↔agent messages internally while the human sees everything in the group.

## Architecture at a glance

```
   ┌──────────────── hub (always-on service) ─────────────────┐
   │  adapters:  telegram (poll)   [ teams (webhook) — later ] │
   │  sole consumer per bot · agent registry · loop governor   │
   └───────────────▲───────────────────────────▲──────────────┘
                   │ local socket / HTTP (register + route)
        ┌──────────┴─────────┐          ┌───────┴────────────┐
        │ Claude session A   │   …      │ Claude session B   │
        │ thin channel       │          │ thin channel       │
        │ (claude --channels)│          │ (claude --channels)│
        └────────────────────┘          └────────────────────┘
```

- **Hub** — the single always-on owner of every platform connection, the agent registry,
  message routing, and the loop governor. Adapters plug in behind one small interface.
- **Thin channel** — a Claude Code channel (an MCP server) each session loads with
  `--channels`. It polls nothing; it registers with the hub, injects inbound messages into
  the live session, and relays the session's replies back out.

Full technical reference: [docs/conventions.md](docs/conventions.md).

## Concepts

- **Agent** — a Claude Code session registered with the hub under a logical name (e.g.
  `re-infra`). One Telegram bot fronts every agent; the hub routes by `@name` tag, so adding
  an agent is config, not a new bot.
- **Shared room** — a Telegram group where a human tags agents (`@re-infra …`) and agents tag
  each other. The hub re-injects agent→agent messages (the platform won't carry bot→bot), so
  coordination stays fully visible to the human and interruptible.
- **Loop governor** — a human tag opens a coordination thread with a bounded hop budget;
  agent→agent hops decrement it, human messages refill it, and it freezes with a notice at
  zero. No runaway agent-to-agent conversations.

## Repository layout

```
packages/
  protocol/   shared message types, session↔hub wire protocol, config schemas (the versioned seam)
  channel/    thin Claude Code channel plugin (MCP server + .claude-plugin/plugin.json + .mcp.json)
  hub/        always-on hub: session server, registry, @tag routing, loop governor, adapters/telegram
deploy/systemd/       systemd unit for a co-located hub
docs/                 conventions.md, protocol.md, configuration.md, deploy/, runbooks/
Dockerfile · docker-compose.yml
```

## Deploy & use

**→ [docs/usage.md](docs/usage.md) is the complete end-to-end guide** — deploy the hub, install the
channel plugin, attach sessions as named agents, and use DMs / groups / agent↔agent coordination.

One always-on hub; the **same image runs everywhere** — only the environment differs
([docs/configuration.md](docs/configuration.md)).

- **Full walkthrough** — [docs/usage.md](docs/usage.md)
- **Coordination protocol** — [docs/coordination.md](docs/coordination.md): how agents should behave
  in a shared room (quiet by default; don't drop the ball) — reference it from every project.
- **Docker / Compose** — `cp packages/hub/.env.example .env`, edit it, then `docker compose up -d`.
- **Azure Container Instances** — [docs/deploy/azure-container-instances.md](docs/deploy/azure-container-instances.md)
- **systemd (co-located)** — [deploy/systemd/claude-telegram-hub.service](deploy/systemd/claude-telegram-hub.service)
- **Thin channel install** — [docs/deploy/channel-install.md](docs/deploy/channel-install.md)
- **Voice (speech-to-text)** — [docs/deploy/voice-stt.md](docs/deploy/voice-stt.md): opt-in `HUB_STT_URL` + a self-hosted Whisper sidecar
- **Operations runbook** — [docs/runbooks/operations.md](docs/runbooks/operations.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — issue-first, a branch per issue, a PR that links it.
Never commit secrets; all tokens/keys come from the environment.

## License

[MIT](LICENSE)
