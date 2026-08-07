# Technical Reference

## What this tool is

`claude-telegram-hub` bridges **Telegram** to **interactive Claude Code sessions** without
changing how Claude runs. Claude stays as it is today — an interactive session on the user's
machine, on the user's subscription, live in a repo working directory. The tool owns only the
*transport*, split into two pieces:

- **The hub** — one always-on service that authenticates to Telegram (a single bot), holds the
  registry of connected agents, routes messages, and enforces the loop governor.
- **The thin channel** — a Claude Code *channel* (an MCP server) that each session loads with
  `--channels`. It polls nothing; it attaches to the hub, injects inbound messages into the
  live session, and relays the session's replies back out through the hub.

Design goal: **never reintroduce a per-session poller.** The failure modes that make the
built-in plugin fragile — one-consumer-per-token collisions, dead pollers that don't restart,
shared-state footguns — all come from each session owning a platform connection. Here the hub
is the single owner; sessions attach and detach freely.

## Components

| Component | Runs where | Responsibility |
|-----------|-----------|----------------|
| **Hub** | one always-on process (systemd unit or container) | Telegram connection, agent registry, `@tag` routing, agent↔agent re-injection, loop governor, allowlist |
| **Adapter** | in-process plugin inside the hub | Normalize one platform's messages to/from the hub's internal shape. `telegram` first; `teams`/`slack` later, same interface |
| **Thin channel** | one per Claude session, loaded via `--channels` | Register the session as a named agent, inject inbound → session, send session replies → hub |

## How a Claude Code channel works (the mechanism we build on)

A "channel" in Claude Code is an ordinary plugin (`plugin.json`) that ships an **MCP server**
(`.mcp.json`) and is activated with `claude --channels plugin:<name>`. Two moving parts:

- **Injection** — the MCP server emits a `notifications/claude/channel` notification; the
  Claude Code channel host injects its payload into the running session as if a new turn
  arrived.
- **Reply** — the server exposes tools (`reply`, and optionally `react`/`edit`) that the
  session calls to send a response back out.

Our **thin channel** is exactly this, but instead of talking to Telegram it talks to the hub:
inbound messages arrive from the hub and become `notifications/claude/channel`; the `reply`
tool forwards the session's text to the hub, which sends it via the adapter.

## Adapter interface (the pluggable seam)

Every transport implements one small interface; the hub core is transport-agnostic.

```ts
interface TransportAdapter {
  name: string                                            // "telegram" | "teams" | ...
  start(inbox: (m: InboundMessage) => Promise<void>): Promise<void>
  send(target: RouteTarget, out: OutboundMessage): Promise<void>
  stop(): Promise<void>
}

interface InboundMessage {
  adapter: string
  room: string          // chat/group id (platform-native)
  fromKind: "human" | "agent"
  fromId: string        // platform user id, or agent name for re-injected messages
  text: string
  mentions: string[]    // resolved agent names tagged in the message
  attachments?: string[]
}
```

- Telegram (`telegram`) is **outbound long-poll** — the adapter runs `getUpdates` and can live
  entirely inside the hub.
- Teams (`teams`, later) is **inbound webhook** — it needs the hub's single public HTTPS
  endpoint. This is why the hub, not the session, owns transport.

## Agent registry & routing

- **One Telegram bot fronts all agents.** Agents are logical names the hub owns (e.g.
  `re-infra`, `re-gitops`), not separate bots. Adding an agent is config + a session
  registration — never a new BotFather bot, group-admin promotion, or token. (The bot must be
  a **group admin** so Telegram delivers it all group messages; see constraints below.)
- **Sessions register with the hub** over a local channel (unix socket or localhost HTTP),
  declaring their agent name (derived from the repo, e.g. the working-directory basename) and
  a shared secret. The hub maps `agent name ↔ live session`.
- **One live session per name (no split-brain).** If a second session registers under a name a
  **live** session already holds, the hub (default `HUB_DUPLICATE_NAME=reject`) keeps the incumbent,
  rejects the newcomer with a fatal `name_in_use` error, and posts a room notice. It tells a real
  duplicate from a restart by actively pinging the incumbent: a genuine restart's old socket is
  half-open and fails the ping, so it's taken over and the reconnect attaches. `replace` restores
  the old newcomer-wins behavior.
- **Routing is by `@tag`, uniformly.** The hub parses every inbound message for agent tags and
  delivers only to tagged agents — human→agent and agent→agent use the same path. Untagged
  chatter is not injected (explicit-mention-only, to bound noise and loops).
- **A Telegram reply is an equivalent addressing signal.** Since the one bot posts every agent's
  messages, the Telegram adapter keeps a bounded `message_id → agent` index of what it sends;
  when an inbound *replies to* one of those messages it resolves the target agent and adds it to
  the message's mentions, so hub routing stays tag-based. Reply-to and `@tags` compose.
- **Attribution.** Because one bot posts everything, the hub prefixes each outbound with the
  speaking agent's name so the group stays legible (e.g. `re-infra ▸ …`).
- **Offline target.** If a tagged agent has no live session, the hub reports it in the room
  rather than silently dropping.
- **Presence (opt-in).** With `HUB_PRESENCE` on, the hub posts `@agent online/offline` to the
  configured rooms as sessions come and go, so the operator can see who's reachable. It's
  debounced: online fires only on an agent's first live registration, and offline only after a
  grace window with no live session — so a session restart (a displace-then-detach plus a
  reconnect) doesn't flap. The notices are hub-generated and governor-neutral (not agent→agent hops).

## Files & images

Text isn't the only payload. An operator's photo/document (with a caption that tags an agent) and
an agent's outbound file both travel as **bytes over the session↔hub WebSocket** — the same link
that already carries messages — so file transfer works whether the hub is co-located or remote:

- **Inbound.** The hub (which holds the bot token) downloads the file from the platform, then
  streams the bytes to the tagged session's channel. The **channel** — always co-located with its
  session — writes them to a local temp file and surfaces that path (`attachment_path`) to the
  agent, which opens it with its normal file tools. Routing is unchanged: the caption is treated as
  the message text, so an untagged file isn't delivered. Files over the Bot API's 20 MB download
  limit aren't fetched; the agent gets the caption plus a note.
- **Outbound.** The agent calls the channel's `send_file` tool with a local path (+ optional
  caption). The channel reads the bytes and sends them through the hub; the adapter uploads them —
  as a photo for small images, otherwise a document (preserving the file, up to ~50 MB). Captions
  are attributed like replies.

Files are human-facing: there is no agent→agent file re-injection, and file sends don't touch the
loop governor.

## Agent-to-agent coordination

The platform will **not** deliver one bot's message to another bot (see constraints). The hub
sidesteps this: every agent reply passes *through* the hub, so when a reply tags another agent
the hub **re-injects** it into that agent's session directly and also posts it to the group for
the human to see. Telegram carries the human-visible copy; the hub carries the actual agent→agent
hop. The result is a shared room where the human and every agent see the same transcript, and
the human can interrupt at any point.

## Loop governor (bounded coordination)

Two layers, because prompt-level discipline alone won't hold:

- **Soft (downstream, in the agents' own prompts/conventions):** agents are instructed to
  converge — summarize and hand back to the human rather than volley, and not to reflexively
  re-tag. This lives in the *consuming project's* conventions, not in this tool.
- **Hard (the hub, authoritative):** each human message that tags agents opens a *coordination
  thread* with a **hop budget**. Each agent→agent re-injection decrements it; any human message
  refills it (human presence = license to continue). At zero the hub **freezes agent→agent
  routing for that thread** and posts a notice; the human resumes it. This guarantees no
  infinite agent-to-agent loop regardless of model behavior.

## Auth & security

- **hub ↔ Telegram** — a single bot token, from the environment (or a secret store). One
  credential to manage; never in the repo.
- **session ↔ hub** — a shared secret plus the declared agent name; the hub rejects
  registrations that don't present it, so a stray process can't impersonate an agent.
- **Allowlist** — the hub only accepts messages from allowlisted platform user ids; unknown
  senders are dropped by default. `HUB_ALLOWLIST` is the **seed**; admins (`HUB_ADMINS`, defaulting
  to the seed) can adjust access at runtime from chat — `/allow <id>`, `/deny <id>`, `/allowlist`,
  `/pending` — with changes persisted to `HUB_STATE_FILE` so they survive a restart (effective set =
  seed ∪ runtime-allowed − denied). With `HUB_PAIRING=on`, an unknown sender is queued as `pending`
  and admins are notified instead of a silent drop, so access can be granted with one command.
  Non-admins running an admin command are ignored; a leading-slash message that isn't a known
  command (e.g. `/deploy @agent`) routes normally.
- **Permission posture** — the hub is a transport; it does not widen what a session can do.
  Since chat can drive real tool use, the consuming project should choose the session's
  permission mode deliberately (reads free, writes/commands gated) — that decision lives with
  the session, not the hub.

## Configuration

All config is environment / a gitignored `.env` (never tracked):

| Setting | Purpose |
|---------|---------|
| bot token | the single Telegram bot the hub authenticates as |
| allowlist | platform user ids permitted to talk to the hub |
| room(s) | group id(s) the hub operates in |
| session↔hub secret | shared secret sessions present when registering |
| hop budget | default coordination-thread budget + refill rule |
| presence | announce agent online/offline in the rooms (opt-in) + reconnect grace window |
| tag sigil | the token that marks an agent mention (e.g. `@`) |

## Deployment

The hub is a long-lived service — run it under **systemd** (co-located with the sessions) or as
a **container** (e.g. an always-on service in a container platform). Sessions attach over a
local socket / localhost HTTP, so co-locating the hub with the sessions is the simple default;
a remote hub is possible but adds a network hop and its own auth surface. The Teams adapter
(later) additionally needs the hub's HTTPS endpoint reachable by the platform.

## Known platform constraints (Telegram)

These are Telegram-side facts the design works *around*, not bugs to fix:

- **Bots never receive other bots' messages.** Enforced server-side; no setting changes it.
  This is *the* reason agent↔agent coordination goes through the hub, not the platform.
- **Privacy mode.** By default a bot in a group only receives `@mentions`/replies/commands.
  Making the hub bot a **group admin** disables privacy mode so it receives every message (which
  the hub needs, to route by tag). Privacy changes require re-adding the bot.
- **One `getUpdates` consumer per token.** Only one process may long-poll a bot token at a time
  — which is exactly why exactly one hub owns the token, and sessions never poll.

## Tech stack (proposal — confirm in the design issue)

- **Language:** TypeScript. The thin channel is an MCP server, so the official MCP SDK
  (Node/Bun) is the natural fit; sharing the language across hub + channel keeps the adapter
  and message types shared.
- **Telegram:** a maintained Bot API library (e.g. grammY).
- **session↔hub transport:** unix socket or localhost HTTP (open decision).

Open decisions tracked in the design issue: tag sigil, default hop budget + refill rule,
session↔hub transport, DM→agent routing default, runtime (Node vs Bun).
