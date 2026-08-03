# Operations runbook

Operating the hub and channels. See also
[deploy/azure-container-instances.md](../deploy/azure-container-instances.md),
[channel-install.md](../deploy/channel-install.md), and the systemd unit under
`deploy/systemd/`.

## Start / stop the hub

- **Docker Compose:** `docker compose up -d` / `docker compose down` (reads `.env`).
- **systemd:** `systemctl start|stop|restart claude-telegram-hub`; logs via
  `journalctl -u claude-telegram-hub -f`.
- **Bare node:** `node packages/hub/dist/main.js` with the environment set.

The hub logs structured JSON to stdout.

## Health

- `GET /healthz` → `200 ok` while the process is up (liveness).
- `GET /readyz` → `200 ready` once the adapter has started, else `503` (readiness).

Use `/readyz` for load-balancer / orchestration probes.

## Add an agent

Agents are logical names, not new bots. To add one, attach a new session with a distinct
`TELEGRAM_HUB_AGENT` (or run in a repo whose basename is the desired name) — see
[channel-install.md](../deploy/channel-install.md). No hub change or new BotFather bot needed.

## Rotate the session secret

1. Set the new `HUB_SESSION_SECRET` and restart the hub.
2. Update every session's `TELEGRAM_HUB_SECRET` to match; sessions re-register on reconnect.

Mismatched sessions are rejected with `auth_failed`.

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `telegram long-poll failed to start … 401` | Bad `TELEGRAM_BOT_TOKEN` | Use a valid BotFather token. |
| Bot doesn't see group messages | Privacy mode on | Make the hub bot a **group admin** (disables privacy); re-add the bot. |
| `getUpdates` conflict / dropped updates | Two processes on one token | Run exactly **one** hub per token. |
| Session rejected `auth_failed` | Secret mismatch | Align `TELEGRAM_HUB_SECRET` with the hub's `HUB_SESSION_SECRET`. |
| Session rejected `version_mismatch` | Protocol major skew | Upgrade hub image and channel package together (below). |
| Tagged agent silent | Agent offline | The hub posts an in-room offline notice; start/attach that agent's session. |
| Agent↔agent chatter stops with a "paused" notice | Hop budget exhausted | Expected — a human message in the room resumes it. Tune `HUB_HOP_BUDGET`. |

## Protocol version compatibility

The hub and the installed channel plugins ship on independent clocks. The channel sends its
protocol **major** in the register handshake; the hub requires an exact major match and otherwise
rejects with `version_mismatch` (fatal). Backward-compatible additions do not bump the major.
**Across a protocol-major bump, upgrade the hub image and the channel package together.** See
[docs/protocol.md](../protocol.md#version-negotiation).

## Loop governor tuning

`HUB_HOP_BUDGET` (default 6) bounds agent→agent hops per coordination thread. A human message
refills/unfreezes the thread. Lower it to make agents converge sooner; raise it for longer
autonomous exchanges.
