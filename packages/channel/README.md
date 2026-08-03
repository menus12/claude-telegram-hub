# @claude-telegram-hub/channel

The **thin channel**: a Claude Code channel plugin (an MCP server over stdio) that each session
loads with `--channels`. It **polls nothing** — it holds one persistent WebSocket to the hub,
injects inbound messages into the live session as `notifications/claude/channel`, and relays the
session's replies back through the hub's `reply` tool.

A single installed plugin can attach **different sessions to different hubs** — config resolves
per session from layered sources.

## Configure

Config resolves in precedence order (**earlier wins**), agent name defaulting to the
working-directory basename:

```
env (per-repo)  >  .telegram-hub.json (repo)  >  ~/.config/claude-telegram-hub/config.json  >  cwd basename
```

| Env var | Required | Default | Purpose |
|---------|----------|---------|---------|
| `TELEGRAM_HUB_URL` | yes | — | Hub URL, e.g. `ws://127.0.0.1:8787` (local) or `wss://hub.example.com` (remote). |
| `TELEGRAM_HUB_SECRET` | yes | — | Shared secret; must equal the hub's `HUB_SESSION_SECRET`. |
| `TELEGRAM_HUB_AGENT` | no | cwd basename | This session's agent name. |
| `TELEGRAM_HUB_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` (logs go to stderr). |
| `TELEGRAM_HUB_RECONNECT_INITIAL_MS` | no | `500` | Initial reconnect backoff. |
| `TELEGRAM_HUB_RECONNECT_MAX_MS` | no | `15000` | Max reconnect backoff. |

A repo-local `.telegram-hub.json` accepts the same keys in camelCase (`hubUrl`, `sessionSecret`,
`agent`, …). See [`.env.example`](.env.example). Never commit secrets.

## Build & attach (development)

```sh
npm run build -w @claude-telegram-hub/channel        # emits dist/main.js
# point Claude Code at this plugin directory and activate the channel:
TELEGRAM_HUB_URL=ws://127.0.0.1:8787 TELEGRAM_HUB_SECRET=… \
  claude --plugin-dir packages/channel --channels plugin:telegram-hub
```

The plugin ships:
- `.claude-plugin/plugin.json` — plugin manifest (`name: telegram-hub`).
- `.mcp.json` — launches the server as `node ./dist/main.js` over stdio.

## Notes / caveats

- **stdout is the MCP transport** — the server writes only protocol traffic there; all logs go to
  stderr.
- The exact `--channels plugin:<name>` resolution (local dir vs marketplace) and the
  `notifications/claude/channel` delivery are Claude Code features still stabilizing; if injection
  doesn't surface, verify your Claude Code version. Packaging/marketplace distribution is
  finalized in Stage 6.
