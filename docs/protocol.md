# session↔hub wire protocol

The versioned contract between the **hub** and each session's **thin channel**. It is defined
once in `packages/protocol` (Zod schemas + inferred TypeScript types) and imported by both
artifacts, so the two can never drift apart silently.

> Status: **v1 (protocol major `1`)**. Stage 0 defines the types and validation; the transport
> that carries them (WebSocket + HTTP) is implemented in Stages 1–2.

## Transport

- The session opens **one persistent connection** to the hub at a configurable URL (WebSocket
  in v1). This is **not** a poller — only the hub polls the platform. The single hub link is how
  the hub *pushes* inbound messages to the session and how the session *sends* replies.
- The hub is reachable over the network (local or remote, e.g. a container in Azure), so the
  connection is authenticated: the session presents a shared secret at registration.
- Frames are JSON objects discriminated by a `type` field. `packages/protocol` exports schemas
  for each frame plus `sessionToHubFrameSchema`, `hubToSessionFrameSchema`, and `wireFrameSchema`.

## Version negotiation

`PROTOCOL_VERSION` is the protocol **major** version. The session sends it in the `register`
frame; the hub calls `isProtocolCompatible(peer)` and requires an **exact major match**.

- Backward-compatible additions (new optional fields, new frame types a peer may ignore) live
  **within** a major and do not bump it.
- Any breaking change to an existing frame increments the major; both sides must then upgrade.
- On mismatch the hub replies with an `error` frame (`code: "version_mismatch"`, `fatal: true`)
  and closes the connection. This guards the real-world skew where a hub is upgraded in a
  container while older plugins still sit on developer machines.

## Frames

### session → hub

| `type` | Purpose | Fields |
|--------|---------|--------|
| `register` | First frame; authenticate + declare identity + version | `protocolVersion`, `agent`, `secret` |
| `reply` | A message to deliver back out through the hub | `room`, `text`, `mentions[]` (default `[]`), `replyToId?` |
| `send_file` | A file to deliver out to a room (agent → operator/room) | `room`, `file` (`FilePayload`), `caption?` |
| `heartbeat` | Liveness keepalive | — |

### hub → session

| `type` | Purpose | Fields |
|--------|---------|--------|
| `registered` | Registration accepted | `agent`, `protocolVersion` |
| `inbound` | A message to inject into the session | `message` (`InboundMessage`), `coordinationThread?`, `file?` (`FilePayload`) |
| `error` | A frame/connection was rejected | `code`, `message`, `fatal` (default `false`) |

`error.code` is one of: `version_mismatch`, `auth_failed`, `unknown_agent`, `not_allowlisted`,
`bad_request`, `name_in_use` (a live session already holds the requested agent name; the newcomer
is rejected — `fatal` — under the default `reject` policy).

## Message shapes

- **`InboundMessage`** — a transport-agnostic message the router reasons about: `adapter`,
  `room`, `fromKind` (`human` \| `agent`), `fromId` (platform user id, or agent name when
  re-injected), `text`, `mentions[]`, `attachments?`. Nothing here is Telegram-specific.
- **`OutboundMessage`** — a message leaving through an adapter: `agent` (the speaker, for
  attribution), `text`, `kind` (`reply` \| `notice`).
- **`RouteTarget`** — where an outbound goes: `adapter`, `room`, `replyToId?`.
- **`FilePayload`** — a file carried as bytes: `filename`, `mimeType`, `dataBase64`. Files travel
  over the same WebSocket as messages, so file transfer works whether the hub is co-located or
  remote. The channel (always co-located with its session) is what materializes an inbound file to
  a local path and reads a local path for an outbound one; the hub only moves bytes and, for
  Telegram, downloads/uploads them. Size is bounded per deployment (see configuration).

## Injection & reply (the channel mechanism)

The thin channel is an ordinary Claude Code channel:

- **Injection** — when an `inbound` frame arrives, the channel emits a
  `notifications/claude/channel` MCP notification carrying `message.text` (labeled as *from
  agent X* when `message.fromKind === "agent"`, so the receiver treats it as a peer request, not
  a human directive), and the Claude Code host injects it into the live session.
- **Reply** — the session's `reply` tool produces a `reply` frame the channel forwards to the
  hub, which routes it (and re-injects it to any tagged agent).

## Notices

Hub-generated, human-visible messages are `OutboundMessage`s with `kind: "notice"`, posted to
the room verbatim (no attribution prefix). `packages/protocol` provides builders:

- `offlineTargetNotice(agent)` — a tagged agent has no live session (reported, never dropped).
- `loopFrozenNotice()` — a coordination thread's hop budget is exhausted; a human reply resumes.
- `presenceOnlineNotice(agent)` / `presenceOfflineNotice(agent)` — an agent's session came online / went offline (opt-in, `HUB_PRESENCE`).
- `slaEscalationNotice(from, to, minutes)` — an agent→agent `@`-ask went unanswered past the answer window (opt-in, `HUB_SLA`).

`renderOutbound(msg)` renders a reply with its `agent ▸ ` attribution prefix and a notice
verbatim.
