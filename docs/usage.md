# Usage guide — hub + channel, end to end

This is the complete walkthrough from zero to a multi-agent Telegram room: deploy the **hub**, install the **channel plugin**, attach one or more Claude Code sessions as named agents, and use it in DMs, groups, and agent↔agent coordination.

Two pieces:

- **Hub** — one always-on service that owns the Telegram bot (the single `getUpdates` consumer), the agent registry, `@tag` routing, and the loop governor. Same image everywhere; only the environment differs.
- **Channel plugin** — installed once per machine. Each Claude Code session loads it and attaches to the hub under an **agent name**. It polls nothing; it holds one WebSocket to the hub.

> Validated live against Claude Code 2.1.205 and a real bot: DM, group, and agent↔agent ping-pong with the loop governor freezing at the hop budget.

---

## Prerequisites

- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- The **numeric Telegram user id(s)** allowed to talk to the hub (get yours from [@userinfobot](https://t.me/userinfobot)).
- **Exactly one poller per bot token.** If another Telegram integration uses this token (e.g. the official Claude Code `telegram` plugin), disable it so it doesn't compete for `getUpdates`:
  ```sh
  claude plugin disable telegram@claude-plugins-official
  ```

---

## 1. Deploy the hub

Config is entirely environment-driven (see [configuration.md](configuration.md)). Minimum:

| Env var | Value |
|---------|-------|
| `HUB_ADAPTER` | `telegram` |
| `TELEGRAM_BOT_TOKEN` | your BotFather token |
| `HUB_SESSION_SECRET` | a strong shared secret (sessions must present it) |
| `HUB_ALLOWLIST` | comma-separated numeric user ids |
| `HUB_BIND_HOST` / `HUB_BIND_PORT` | `0.0.0.0` / `8787` for a container; `127.0.0.1` / `8787` co-located |
| `HUB_HOP_BUDGET` | agent↔agent hops before the governor freezes (default `6`) |

Run it one of these ways:

```sh
# Docker Compose (reads .env)
cp packages/hub/.env.example .env   # then edit
docker compose up -d

# or plain Docker
docker build -t claude-telegram-hub .
docker run -d --env-file .env -p 8787:8787 claude-telegram-hub

# or co-located (systemd) — see deploy/systemd/claude-telegram-hub.service
# or from source
npm ci && npm run build && node packages/hub/dist/main.js
```

Remote/container deploy (Azure Container Instances): [deploy/azure-container-instances.md](deploy/azure-container-instances.md).

**Verify:**
```sh
curl localhost:8787/healthz   # -> ok
curl localhost:8787/readyz    # -> ready
```

**Telegram bot setup:**
- For **groups**, add the bot and make it a **group admin** — that disables privacy mode so it receives every message and can route by `@tag`. (Privacy changes require re-adding the bot.)
- For **DMs**, nothing extra — the bot receives DMs directly.

---

## 2. Install the channel plugin (once per machine)

> **Prerequisite — Node ≥22 on the agent host.** The host runs **Claude Code**, whose CLI requires **Node ≥22**; the packages' `engines: ">=18.18"` is the *build* floor for the hub/channel, **not** the agent-runtime floor. The effective requirement for a session host is `max(build ≥18.18, Claude Code ≥22)` = **Node 22**. Watch out: `npm` reports the Claude Code engine mismatch as an `EBADENGINE` **warning**, not an error, and `claude --version` still prints — so a Node-20 host *looks* fine but fails at runtime. Debian 13 (trixie) ships Node **20** in `apt`, which is **insufficient** — install Node 22 from the official [nodejs.org](https://nodejs.org/en/download) tarball (verify against `SHASUMS256.txt`) or nodesource, not distro `apt`.

```sh
npm run build -w @claude-telegram-hub/channel
claude plugin marketplace add /path/to/claude-telegram-hub
claude plugin install telegram-hub@claude-telegram-hub
claude plugin list        # -> telegram-hub@claude-telegram-hub  ✔ enabled
```

> **Low-memory / slow-storage hosts (e.g. an ARM SBC):** the built plugin is a single bundled `dist/main.cjs` with **no runtime `node_modules`** (deps are inlined at build; only ws's optional native accelerators are external and ws runs without them). So you can build it on a beefier machine and ship just `dist/` + `.claude-plugin/` + `.mcp.json` to the host — no `npm ci`/build there, avoiding the memory peak and the slow many-small-files unpack on eMMC. The host then needs only the Node 22 runtime.

The marketplace points at this repo (`.claude-plugin/marketplace.json`); the plugin's server is `plugin:telegram-hub:telegram-hub`.

---

## 3. Attach a session as a named agent

Each session registers under an **agent name** — this is what humans `@tag`. A single installed plugin attaches different sessions to different hubs/agents; config resolves per session (**earlier wins**):

```
env  >  ./.telegram-hub.json (repo)  >  ~/.config/claude-telegram-hub/config.json  >  cwd basename
```

Give each session its own agent name. The reliable way is env (inherited by the plugin's MCP server):

```sh
export TELEGRAM_HUB_URL=ws://127.0.0.1:8787          # or wss://your-hub
export TELEGRAM_HUB_SECRET=<same as hub HUB_SESSION_SECRET>
export TELEGRAM_HUB_AGENT=re-infra                    # this session's agent name
```

Then **launch Claude Code with the channel activated**. Claude Code gates channel injection behind an approved-channels allowlist; a locally-developed channel is activated with the dev flag and the `plugin:<name>@<marketplace>` tag:

```sh
claude --dangerously-load-development-channels plugin:telegram-hub@claude-telegram-hub
```

- The dev flag is intentionally scary — it means "trust this locally-developed channel," and it triggers an interactive **"local development" confirmation on *every* launch** (which has no TTY to answer on a headless host — see the callout). For anything past a quick interactive try — and **required for headless/systemd** — **approve the plugin instead and drop the flag**: add it to **managed settings** (`/etc/claude-code/managed-settings.json`, readable by the session user), then launch with plain `--channels plugin:telegram-hub@claude-telegram-hub`:
  ```json
  { "channelsEnabled": true,
    "allowedChannelPlugins": [{ "marketplace": "claude-telegram-hub", "plugin": "telegram-hub" }] }
  ```
  It must be **managed** settings (not `~/.claude/settings.json`) for the approval to be non-interactive and persistent, and the plugin's marketplace must already be known (`claude plugin marketplace add`).
- **Without activation, the channel connects and the hub injects, but Claude Code never surfaces the message as a turn.** This is the single most common gotcha.

**Verify the attach:**
```sh
claude mcp list           # -> plugin:telegram-hub:telegram-hub  ✔ Connected
```
and the hub logs `session registered {agent: "re-infra"}`.

> **Headless / always-on (systemd) hosts — pre-accept the startup dialogs.** On first run Claude Code shows **two interactive startup prompts _before the channel loads_**: the folder-**trust** dialog ("Is this a project you trust?") and, with `--dangerously-skip-permissions`, a **bypass-permissions** confirmation. A systemd/tmux session has no TTY to answer them, so it **hangs silently** — the tell is a unit that's `active` with linger + auto-start but makes **zero hub registration attempts** and holds only a few MB RSS (that's the tmux wrapper, not a live Claude: "green status, dead service"). This is the harness-level analog of [Rule 0](coordination.md) (never block on local input), one layer below the channel. **Fix — both conditions together:** set `hasTrustDialogAccepted: true` (and your intended permission mode) for the working directory's project in `~/.claude.json` **before** the first systemd start, **and** with **no second Claude session running** — two sessions writing `~/.claude.json` race and the flag rolls back to `false`. Mind the **duplicate-name** interaction too: a manual session and the unit register the *same* agent name, so the hub's duplicate guard rejects the second — the manual one holds the hub while the unit stays silent; close the manual session so the unit registers. **And a third gate if you launch with the dev flag:** `--dangerously-load-development-channels` adds a per-launch "local development" confirmation that never persists to config — on a headless host **don't use it**; approve the plugin in managed settings and launch with plain `--channels` (above). All three gates must be clear for the unit to come up silent. Run the session under a **systemd `--user` unit with linger** (survives logout + reboot), and finish with a **control reboot to _prove_ auto-start** (confirm it actually rebooted via `uptime`/boot time — the hub can't tell a reboot from a manual restart), not assume it.

> **Per-agent naming:** don't put `agent` in the machine config (`~/.config/...`) — that forces every session to the same name and they'll displace each other. Set `TELEGRAM_HUB_AGENT` per session (or a per-repo `.telegram-hub.json`). Keep shared `hubUrl`/`sessionSecret` in the machine config if you like.

---

## 4. Use it

- **DM** — message the bot `@re-infra <text>`. It surfaces in that session; the reply returns to your DM, attributed `re-infra ▸ …`.
- **Group** — in a group the bot administers, `@re-infra <text>` routes to that agent; a human may tag several agents and each replies into the group.
- **Reply to address** — Telegram-**reply** to an agent's message to route your follow-up to that agent, no `@tag` needed. Resolution is stateless — the author is recovered from the message's `agent ▸ …` attribution — so it works even for messages sent before a hub restart (a fast in-memory index is used first). Replies to hub notices (which carry no attribution) aren't routed.
- **Reply-to + tag delivers to both, framed per recipient (#92 / Option A)** — reply to an agent's message **and** tag another (`@other`) and **both** receive it: the replied-to agent is addressed (it sees `↩ In reply to your earlier message …` — so an instruction in your reply reaches it), and `@other` is pulled in with the quoted message as context (it sees `↩ In reply to <that-agent> …` — so it knows the reply is directed at them, not itself). This fixes the trap where one reply both instructs the replied-to agent ("upload the files") and asks a tagged peer something ("@other, status?") — previously only the peer got it and misread the whole text as its own. A reply with *no* tag still just continues the thread with the replied-to agent (no quote). Only the addressed agents receive it — the quiet room is preserved. Pair with `no_reply` when a tag is for visibility only.
- **Files & images** — send a photo/document to an agent by attaching it with a caption that tags the agent (`@re-infra` in the caption); the hub downloads it, streams the bytes to that session, and the agent gets a **local path** to open. An agent sends a file back with the `send_file` tool (a local path + optional caption); it arrives in the chat as a photo (images) or document. To hand a file to **peer agents**, add their names in `send_file`'s `mentions` — each receives the bytes at its own local path (the same materialization inbound files use), while the visible copy still posts to the room; without `mentions` a file is operator-facing only. Bytes travel over the session↔hub WebSocket, so this works with a co-located **or** remote hub. Limits: 20 MB inbound (Bot API), ~50 MB outbound documents.
- **Multi-agent** — run one session per project, each with a distinct `TELEGRAM_HUB_AGENT`. In the shared group:
  - **Address one, several, or all.** Recipients are just a set, so: `@re-infra` (unicast) · `@re-infra @re-gitops` (multicast) · `@all` (broadcast — expands to every **live** agent in the room; `@everyone`/`@team` are aliases). Broadcast is **operator-only** (agents coordinate via explicit peer tags, never `@all`) and hits live agents only (no offline-notice spam). Reply-to also addresses the agent you reply to. Disable with `HUB_BROADCAST=off`.
  - An agent can **tag another agent** (`@other-agent …`) in its reply — the platform never carries bot→bot, so the hub **re-injects** the hop into the peer's session and posts a visible copy to the group.
  - **`no_reply: true`** (on `reply`/`send_file`) tags a peer for **visibility only** — it's delivered but arms no response-SLA watch. Because delivery is mention-only, a status/FYI or closing ack that a peer needs to *see* must still tag them; `no_reply` stops that tag from demanding a reply (and prevents the ack-of-the-ack nag). The hub also won't arm a watch when a reply answers the peer it tags back. (#100)
  - A tagged agent with no live session gets an in-room "not connected" notice.
  - **Agents reach the operator with `@operator`** (`mentions: ["operator"]`, #94) — a canonical token the hub turns into a **real Telegram mention** of the human, plus a reply to their last message. To actually **break through a muted group**, set `HUB_OPERATOR_USERNAMES` to the operator's Telegram username(s): a real `@username` mention trips Telegram's muted-chat "Mentions & Replies" exception and pushes a notification. Without it, the hub falls back to an id-link mention of `HUB_ADMINS` — a visible `@` badge, but a bot-generated id-link does **not** reliably notify in a muted chat, so the mention may go unseen. It's mute-breaking (when a username is configured), so agents use `@operator` only when they genuinely need a decision. SLA escalations mention the operator the same way.
  - **Presence (opt-in):** set `HUB_PRESENCE=on` and the hub announces `@agent online/offline` as sessions attach and detach, so you can see who's reachable. It's debounced (`HUB_PRESENCE_GRACE_MS`, default 10s) so a session restart doesn't flap. Delivery follows `HUB_NOTIFY` — `dm` (default; to admins' DMs, so it works with **no group**), `rooms`, or `both`.
  - **Voice notes (opt-in):** set `HUB_STT_URL` (a speech-to-text service — see [design/voice-messages.md](design/voice-messages.md)) and a voice note is transcribed and routed like a typed message. Speech has no `@tags`, so **address it by replying** to an agent's message, or **open by naming** who it's for: "Platform, redeploy" (unicast), "Platform and GitOps, sync up" (multicast), "Everyone, stand down" (broadcast). The hub **echoes the transcript and recipients** (`🎙️ heard → @platform: "…"`, `HUB_VOICE_ECHO`) so you can catch a mis-hear; if it can't tell who a note is for, it asks.
  - **Agents can reply with voice (opt-in):** with `HUB_TTS_URL` set (a text-to-speech service), an agent may pass `voice: true` on its `reply` to also send a **short** reply as a voice note captioned with the text. Text stays the source of truth — the hub skips voicing code, links, or long text (`HUB_TTS_MAX_CHARS`), and falls back to text if synthesis fails.
  - **Loop governor:** each human message opens/refills a per-room budget (`HUB_HOP_BUDGET`, default 6). Agent→agent hops decrement it; at zero the hub freezes agent↔agent routing and posts *"Agent-to-agent coordination is paused (hop budget reached). Reply in this room to resume it."* Any human message resumes it. Human→agent delivery is never frozen.
  - **Response SLA (opt-in):** set `HUB_SLA=on` and the hub watches each agent→agent `@`-ask for a reply. If the peer stays silent it nudges it once (`HUB_ACK_SLA`, default 2m), then escalates to you and unblocks the asker (`HUB_ANSWER_SLA`, default 10m). It's the durable net for when the *asker's* session died with its own follow-up timer; any reply from the peer (ack or answer) cancels it, and the nudge/escalation don't spend the hop budget.

### Managing access from chat

Admins (`HUB_ADMINS`, defaulting to the `HUB_ALLOWLIST` seed) can adjust the allowlist without a redeploy:

- `/allow <user_id>` — grant access (the user is DM'd that they're in).
- `/deny <user_id>` — revoke access (overrides the seed too).
- `/allowlist` — list who's allowed. `/pending` — list access requests.
- `/who` — list live agent sessions with a session id + uptime, flagging any name with rejected duplicate registrations. The way to spot a duplicate/orphaned connection (same name, different id) from chat rather than the logs.
- `/start` — tells a user whether they're authorized (and their id).

### Tuning features from chat

Admins can also change **runtime-tunable settings** without a redeploy — the env value is the baseline; a `/set` layers an override on top:

- `/config` — list every tunable setting with its effective value (`*` marks an override).
- `/set <key> <value>` — override a setting (validated); e.g. `/set ttsauto on`, `/set ttsmaxchars 400`, `/set ttsvoicemap en:af_sky,ru:af_ru`. Room-scoped keys apply to the room the command is sent in.
- `/unset <key>` — drop the override, reverting to the deployment default.
- `/voice on|off` — friendly alias for the per-room voice toggle (voiced replies in **this room** come as text when off).

Tunable today:

- **Behavioural** (take effect on the next message): `broadcast`, `voiceecho`, `pairing`, `ttsauto`, `notify`, `ttsmaxchars`, `ttsvoice`, `ttsvoicemap`, and the room `voice` toggle.
- **Backstops** (reconfigure the live component): `sla`, `ackslams`, `answerslams`, `presence`, `presencegracems`, `hopbudget`, `keepalivems`.

Infrastructure and secrets (bind address, session secret, adapter, STT/TTS URLs + keys) are **boot-only** — `/set` refuses them; change those via env and restart.

Set `HUB_STATE_FILE` (a path on a mounted volume for containers) so runtime changes (allowlist **and** settings) **survive a restart**. With `HUB_PAIRING=on`, an unknown sender is queued and admins are pinged (`/allow <id>` to approve) instead of being dropped silently.

> **How agents should behave in the room** — quiet by default, and don't let a request die in that
> silence — is the [coordination protocol](coordination.md). Reference it from each project's agent
> instructions so every session follows the same rules.

---

## Operations & troubleshooting

Day-to-day operations (start/stop, health, secret rotation, adding agents, protocol-version compatibility): [runbooks/operations.md](runbooks/operations.md).

| Symptom | Cause & fix |
|---|---|
| Session registers, but messages don't appear as `<channel>` turns | Channel not **activated** — launch with `--dangerously-load-development-channels plugin:telegram-hub@claude-telegram-hub`. |
| `claude plugin list` → *failed to load: cache-miss* | The marketplace path lost its `.claude-plugin/marketplace.json`. Ensure it exists at the repo path, then `claude plugin marketplace update claude-telegram-hub`. |
| `/mcp` doesn't list `telegram-hub` | The plugin isn't loaded — confirm it's installed + enabled and start a **fresh** session (plugins load at startup). |
| MCP server errors on start | Config missing (`hubUrl`/`sessionSecret`) or `dist/` not built. The plugin runs `${CLAUDE_PLUGIN_ROOT}/dist/main.cjs`. |
| Two sessions fight over one agent name | Give each a distinct `TELEGRAM_HUB_AGENT`; don't pin `agent` in the machine config. |
| Bot silent / flaky in a group | Bot isn't a group admin (privacy mode on), or **more than one poller** is on the token. Exactly one hub per token. |
| Sender ignored | Their numeric id isn't in `HUB_ALLOWLIST`. |
| Sessions reconnect ~every N seconds / **presence flaps** behind a proxy | A reverse proxy (Azure Container Apps ~240s, nginx 60s, Cloudflare ~100s) is reaping the idle WebSocket. Set `HUB_KEEPALIVE_MS` **below** that timeout (default 30s covers all three) so the periodic ping keeps it warm. |
| Text works but **files/images don't arrive** | Usually a **stale channel** (installed before file support) silently dropping the file — rebuild + reinstall the channel and start a fresh session ([channel-install.md](deploy/channel-install.md)). Also: the file's **caption must tag the agent** (or reply to its message), and inbound files are capped at 20 MB. Check hub logs for `fetched inbound attachment` to confirm the hub forwarded it. |
