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

## Manage the allowlist at runtime

`HUB_ALLOWLIST` is the seed set at deploy; admins can change access live from chat without a
restart. Admins are `HUB_ADMINS` (defaulting to the seed). Commands: `/allow <id>`, `/deny <id>`,
`/allowlist`, `/pending`, `/start`. Set `HUB_STATE_FILE` to a path on persistent storage (a mounted
volume for a container) so the changes **survive a restart** — without it, runtime changes are
in-memory only. With `HUB_PAIRING=on`, an unknown sender lands in `pending` and admins are notified,
rather than being dropped silently. All grants/revocations are logged with who did what.

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
| Session rejected `name_in_use` | Another **live** session already holds that agent name | Give this session a distinct `TELEGRAM_HUB_AGENT`, or stop the other one. A genuine restart isn't rejected (the dead socket is taken over). Set `HUB_DUPLICATE_NAME=replace` to let newcomers take over instead. |
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

## Presence notices

`HUB_PRESENCE=on` makes the hub post `@agent online/offline` to `HUB_ROOMS` as sessions attach and
detach (off by default; needs ≥1 room). It's debounced so restart churn doesn't flap: online fires
on an agent's first live registration, offline only after `HUB_PRESENCE_GRACE_MS` (default 10000)
elapses with no live session. Raise the grace window if sessions routinely take longer than 10 s to
reconnect after a restart; lower it for snappier offline signals.

## Response SLA

`HUB_SLA=on` makes the hub watch each agent→agent `@`-ask for a response — the durable backstop for
a follow-up the asker's own (possibly dead) session couldn't make. If the tagged peer neither acks
nor answers within `HUB_ACK_SLA` (default 120000) the hub nudges it once; if still silent within
`HUB_ANSWER_SLA` (default 600000) it escalates to the operator in the room and unblocks the asker.
`HUB_ANSWER_SLA` must be greater than `HUB_ACK_SLA`. Any reply from the peer cancels both, and the
nudge/escalation are governor-neutral (they don't spend `HUB_HOP_BUDGET`). Off by default; tune the
windows to how long your agents realistically take to respond.
