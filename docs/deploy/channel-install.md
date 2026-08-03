# Install the thin channel

The channel is installed **once per machine** and attaches **many sessions to many hubs** — each
session's `(hub URL, secret, agent name)` selects which deployment it joins. Config resolves per
session (earlier wins):

```
env (per-repo)  >  .telegram-hub.json (repo)  >  ~/.config/claude-telegram-hub/config.json  >  cwd basename
```

See [packages/channel/README.md](../../packages/channel/README.md) and
[packages/channel/.env.example](../../packages/channel/.env.example) for the full config surface.

## Build the package

```sh
npm run build -w @claude-telegram-hub/channel
# produce a tarball (includes dist/, .claude-plugin/, .mcp.json):
npm pack -w @claude-telegram-hub/channel
```

The tarball (`claude-telegram-hub-channel-<version>.tgz`) is the installable artifact — the same
package works for every deployment.

## Attach a session

Point Claude Code at the plugin directory and activate the channel, supplying this session's hub
coordinates via the environment (or a repo `.telegram-hub.json`):

```sh
TELEGRAM_HUB_URL=ws://127.0.0.1:8787 \
TELEGRAM_HUB_SECRET=<same-as-hub-HUB_SESSION_SECRET> \
TELEGRAM_HUB_AGENT=re-infra \
  claude --plugin-dir packages/channel --channels plugin:telegram-hub
```

- `TELEGRAM_HUB_AGENT` is optional; it defaults to the working-directory basename, so different
  repos register under different agent names automatically.
- Attaching a second repo to a **different** hub is just a different `TELEGRAM_HUB_URL` /
  `TELEGRAM_HUB_SECRET` — no reinstall.

## Per-repo config file

For a repo that always attaches to the same hub, drop a gitignored `.telegram-hub.json` at its
root:

```json
{ "hubUrl": "ws://127.0.0.1:8787", "sessionSecret": "…", "agent": "re-infra" }
```

Environment variables still override it. **Never commit secrets** — `.telegram-hub.json` is
gitignored by this repo's `.gitignore`.

## Notes

- The channel talks only to the hub, never to Telegram; it holds one persistent WebSocket and
  polls nothing.
- `--channels` marketplace resolution is a Claude Code feature still stabilizing; `--plugin-dir`
  is the reliable path for local/self-hosted installs today.
