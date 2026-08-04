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

## Install as a plugin + activate the channel (recommended)

Loading via `--plugin-dir` connects the channel to the hub, but Claude Code will **not surface
channel injections** from a channel that isn't *activated* — it gates injection behind an
approved-channels allowlist. For a real end-to-end channel (DMs rendered as `<channel>` turns),
install it as a plugin and activate it explicitly.

This repo ships a marketplace manifest (`.claude-plugin/marketplace.json`) pointing at the channel:

```sh
npm run build -w @claude-telegram-hub/channel
claude plugin marketplace add /path/to/claude-telegram-hub
claude plugin install telegram-hub@claude-telegram-hub
```

Then **activate the channel per session**. A locally-developed channel isn't on the approved
allowlist, so use the dev flag with the `plugin:<name>@<marketplace>` tag:

```sh
claude --dangerously-load-development-channels plugin:telegram-hub@claude-telegram-hub
```

- The tag format matters: `plugin:<plugin-name>@<marketplace-name>` for a plugin-provided channel
  (or `server:<name>` for a manually configured MCP server). The bare server name is rejected.
- `--channels <servers…>` activates channels already on the approved allowlist;
  `--dangerously-load-development-channels` is the local-dev path for unapproved ones.
- Provide the channel's config via `~/.config/claude-telegram-hub/config.json` (the installed
  plugin runs with a clean env), or export `TELEGRAM_HUB_*` before launching.
- Verify the server connected with `claude mcp list` — it appears as
  `plugin:telegram-hub:telegram-hub … ✔ Connected`.

Validated live (Claude Code 2.1.205): with the plugin installed and the channel activated this
way, a Telegram DM `@re-infra …` rendered as a `<channel>` turn and the session's reply returned
to the DM.

## Attach a session (dev, transport only)

> Note: `--plugin-dir` is fine for exercising the transport (the channel connects and the hub
> injects), but injection **surfacing** requires the install + activation flow above.


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
- The plugin's `.mcp.json` launches the server via `${CLAUDE_PLUGIN_ROOT}/dist/main.cjs` — Claude
  Code spawns plugin MCP servers with a cwd that is **not** the plugin root, so a relative path
  would fail to resolve.

## Troubleshooting

- **Nothing registers on the hub / no `telegram-hub` MCP server.** Run `/mcp` in the session. If
  `telegram-hub` is missing or errored, check its stderr for a config error (missing `hubUrl` /
  `sessionSecret`), and confirm `dist/` is built (`npm run build -w @claude-telegram-hub/channel`).
- **Registers, but DMs don't surface as `<channel>` turns.** The channel must be **activated** —
  Claude Code gates injection behind an approved-channels allowlist. Install the plugin and launch
  with `--dangerously-load-development-channels plugin:telegram-hub@claude-telegram-hub` (see
  "Install as a plugin + activate the channel" above). `--plugin-dir` alone connects the transport
  but never surfaces injections. Verified live (Claude Code 2.1.205) for both DM and group.
- **One `getUpdates` consumer per token.** If another Telegram channel (e.g. the official plugin)
  runs on the same bot token, its poller competes with the hub and delivery gets flaky. Disable it
  (`claude plugin disable telegram@claude-plugins-official`) and run exactly one poller.
