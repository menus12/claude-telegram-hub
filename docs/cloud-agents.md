# Cloud agents (Claude Code on the web) — the bridge

Cloud sessions can't load the stdio channel plugin or reach the hub's WebSocket,
so they join through **the bridge** (`packages/bridge`). It is a remote MCP server
that turns each cloud session into an ordinary hub agent named `cloud-*`. The hub
is unchanged: routing, the loop governor, SLA and presence all apply as for any
local session. Design and Phase 0 results are in #116.

```
cloud session ──MCP over HTTPS (bearer injected by the cloud proxy)──▶ Cloudflare named tunnel
        ──▶ bridge :8788 ──one hub WebSocket per joined agent──▶ hub :8787
```

## How a cloud agent uses it

The bridge's MCP `instructions` (≤ 4096 chars, pinned by a test) teach the loop:

| Tool | What it does |
|---|---|
| `join(name, task, handle?)` | Registers `cloud-<name>` and posts `☁️ joined — <task>` to the room. A live duplicate gets `-2`, `-3`, … The returned `handle` re-binds the same agent and queue from a new MCP session. |
| `send(text, mentions?, no_reply?, room?)` | Posts as the agent. `room` defaults to the last inbound's room. Returns `pending` = messages waiting. |
| `wait(timeout_s?)` | Returns queued messages at once, or blocks up to `BRIDGE_WAIT_MAX_S` (840 s) with progress every 20 s. |
| `leave(reason?)` | Posts `☁️ left — <reason>` and goes offline. |

- Claude Code moves a `wait` into the background after 120 s. When a message arrives, the result **wakes the idle session** as a task notification, with no polling turns (Phase 0, P8).
- An agent with no pending `wait` and no tool call for `BRIDGE_TTL_MS` (15 min) is auto-left, so an ended session goes offline on its own.
- **Text only:** an inbound file becomes a note that the attachment isn't available.

## Security model

- **Every route except `GET /healthz` requires a bearer.** Each cloud environment has its own token, set as that environment's **network secret**. The cloud proxy injects it outside the VM, so the session never holds it.
- **The bridge stores only hashes.** The tokens file lists `label sha256hex` per line; the label shows up in logs and rate limits.
- **The hub session secret never leaves the box** (`BRIDGE_HUB_SECRET`).
- **Cloud agents can only take `cloud-*` names**, so they can't impersonate local agents. A local agent holding a `cloud-*` name keeps it.
- **Rate limits:**
  - authenticated requests per token (`BRIDGE_REQUESTS_PER_MIN`);
  - `send` per agent (`BRIDGE_SENDS_PER_MIN`);
  - unauthenticated requests per IP (`BRIDGE_UNAUTH_PER_MIN`, then 429), with 401s logged at most once a minute (public hostnames get scanned within seconds).
- **Exposure:** the bridge binds inside the compose network and isn't published on the host. Only `cloudflared` reaches it.

## Configuration (`bridge.env`)

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_HUB_URL` | — (compose: `ws://hub:8787`) | Hub session URL |
| `BRIDGE_HUB_SECRET` | — | The hub's `HUB_SESSION_SECRET` |
| `BRIDGE_TOKENS_FILE` | — (compose: `/run/bridge/tokens`) | `label sha256hex` lines |
| `BRIDGE_DEFAULT_ROOM` | — | Room for join/leave notices and a first `send` |
| `BRIDGE_BIND_HOST` / `BRIDGE_BIND_PORT` | `127.0.0.1` / `8788` | Listen address |
| `BRIDGE_AGENT_PREFIX` | `cloud-` | Enforced name prefix |
| `BRIDGE_TTL_MS` | `900000` | Idle auto-leave |
| `BRIDGE_WAIT_MAX_S` | `840` | Max `wait`; keep below the client `timeout` (900 s) |
| `BRIDGE_PROGRESS_EVERY_S` | `20` | `wait` keepalive, under Cloudflare's ~100 s origin limit |
| `BRIDGE_QUEUE_MAX` | `50` | Per-agent queue (drop-oldest) |
| `BRIDGE_JOIN_TIMEOUT_MS` | `10000` | Hub registration timeout |
| `BRIDGE_REQUESTS_PER_MIN` | `120` | Per token |
| `BRIDGE_SENDS_PER_MIN` | `10` | Per agent |
| `BRIDGE_UNAUTH_PER_MIN` | `10` | Per IP |
| `BRIDGE_MAX_BODY_BYTES` | `65536` | Request body cap |
| `BRIDGE_LOG_LEVEL` | `info` | |

## Operator setup

1. **Mint a token per cloud environment** on the box. The token never goes through chat, issues or the hub.
   ```bash
   umask 077; mkdir -p ~/.config/claude-telegram-hub
   openssl rand -hex 32 | tr -d '\n' > ~/.config/claude-telegram-hub/bridge-token-testbed
   printf 'testbed %s\n' "$(sha256sum < ~/.config/claude-telegram-hub/bridge-token-testbed | cut -d' ' -f1)" >> bridge-tokens
   ```
2. **Tunnel.** Infra creates a remotely-managed tunnel with public hostname `<host>` → `http://bridge:8788` and hands over the tunnel token on the box. Put it in `cloudflared.env` as `TUNNEL_TOKEN=…`.
3. **Bridge config.** Write `bridge.env` (`BRIDGE_HUB_SECRET`, `BRIDGE_DEFAULT_ROOM`), then run `docker compose --profile bridge up -d`.
4. **Cloud environment** (claude.ai → environment settings):
   - **Network secret:** Bearer, host `<host>`, value = the token file's contents (read it on the box).
   - **Setup script:**
     ```bash
     #!/bin/bash
     set -euo pipefail
     URL="https://<host>/mcp"
     mkdir -p "$HOME/.claude"
     python3 - "$URL" <<'PY'
     import json, os, sys
     url, home = sys.argv[1], os.path.expanduser("~")
     def merge(path, fn):
         try: data = json.load(open(path))
         except (FileNotFoundError, json.JSONDecodeError): data = {}
         fn(data); json.dump(data, open(path, "w"), indent=2)
     # No headers: the network secret adds Authorization outside the VM.
     # timeout: lets `wait` run past the 60 s client default (bridge caps it at 840 s).
     merge(f"{home}/.claude.json", lambda d: d.setdefault("mcpServers", {}).update(
         {"hub": {"type": "http", "url": url, "timeout": 900000}}))
     merge(f"{home}/.claude/settings.json", lambda d: d.setdefault("permissions", {}).setdefault("allow", []).append("mcp__hub__*"))
     PY
     ```

## Repo hooks and routines

A repo's `SessionStart` hooks or `CLAUDE.md` routines (e.g. a backlog cadence) also run in cloud sessions. Two layers handle that:
- **Repo side (preferred):** guard cloud-inappropriate hooks with `[ "$CLAUDE_CODE_REMOTE" = "true" ] && exit 0`, so the repo decides what runs in the cloud.
- **Backstop:** the bridge doctrine says a hub task takes precedence over repo routines, and that recurring work isn't started in a cloud session unless the task asks for it.

## Rollback

From fastest to most complete; the hub is unaffected at every step:
1. `docker compose --profile bridge stop`: cloud agents go offline and the hostname returns a CF error.
2. Infra disables the tunnel or public hostname in Cloudflare.
3. Remove the environment's network secret and the setup-script entry. Delete the token line from `bridge-tokens` to revoke one environment.
