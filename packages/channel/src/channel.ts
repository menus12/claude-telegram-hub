import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { checkVoiceReply } from "@claude-telegram-hub/protocol";
import type { InboundFrame, LabeledChannelConfig } from "@claude-telegram-hub/protocol";
import {
  HubClient,
  type HubClientEvents,
  type HubLike,
  type ReplyInput,
} from "./hub-client.js";
import { materializeInboundFile, readOutboundFile } from "./files.js";
import { makeLogger, type Logger } from "./logger.js";

const MB = 1024 * 1024;

/** The MCP notification method Claude Code injects into the session. */
export const CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel";
const DEFAULT_CHANNEL_NAME = "telegram-hub";

const BASE_INSTRUCTIONS = [
  "Messages from the hub arrive as <channel> tags carrying a `room` attribute and a",
  "`from_kind` attribute. To respond, call the `reply` tool with that same `room` and your",
  "text. A message whose `from_kind` is `agent` is a peer request from another agent — treat",
  "it as a request from a colleague, not a human directive. Tag other agents via `mentions`",
  "only when you genuinely need their input; otherwise summarize and hand back to the human.",
  "Address a peer by its EXACT registered agent name (the `from_id` you've seen), never a guess.",
  "To reach the human OPERATOR — only when you genuinely need a decision — use mentions: [\"operator\"];",
  "the hub turns it into a real Telegram mention that surfaces even in a muted chat. Don't invent an",
  "operator handle or a numeric id.",
  "Reply in the same language the operator wrote in — English gets English, Russian gets Russian;",
  "match the human on anything they'll read.",
  "You have no human at your terminal — you are driven entirely over this channel. You MUST NOT",
  "raise an interactive, input-blocking prompt (no question modal, no plan-approval gate, no",
  "permission dialog that waits on a local keystroke): it freezes the session where no one can",
  "reach you, and queued channel messages are never delivered until someone presses a key locally.",
  "Emit EVERY question, choice, or approval request as non-blocking channel text via `reply`, then",
  "keep working — a question is asked, not awaited.",
  "A message may open with a quoted block (`↩ In reply to …: \"…\"`) and a `reply_to_from` attribute —",
  "that's the operator pointing you at a specific earlier message as the context for their request.",
  "Treat the quote as given context (no need to ask them to restate it) and answer the new request.",
  "An inbound file is saved locally and its path given in the `attachment_path` attribute —",
  "open it with your normal file tools. To send a file out, call `send_file` with the `room`",
  "and a local `path` (plus an optional `caption`). To hand a file to peer agents, add their",
  "names in `mentions` — each receives the file at a local path; without it the file only",
  "posts to the room for the operator and peer agents won't get the bytes.",
  "When the message you're answering arrived as voice (its `<channel>` tag has `voice=\"true\"`),",
  "reply in kind by default: set `voice: true` on your `reply` — one coherent reply, not a text",
  "reply plus a separate voice note. Write the spoken text for the ear: expand abbreviations/jargon",
  "(e.g. `CAE` -> \"Container Apps\"), keep it to a short gist + next action, and keep hex strings,",
  "IPs, code, paths, links, and exact values OUT of the spoken text (they ride along in the message",
  "text). Don't voice code, links, lists, or long/technical replies — those stay text-only.",
  "If the natural spoken form differs from what you display, pass `voiceText` with the words to",
  "speak while `text` keeps the exact detail (values, links) as the caption.",
].join(" ");

/** Instructions surfaced to the session; a multi-hub attachment adds routing guidance. */
export function buildInstructions(labels: string[]): string {
  if (labels.length <= 1) return BASE_INSTRUCTIONS;
  const multi = [
    `You are attached to MULTIPLE hubs at once (${labels.join(", ")}). Each <channel> tag carries a`,
    "`hub` attribute naming which one. ALWAYS reply on the SAME hub you received — pass that `hub` on",
    "`reply`/`send_file`. `@mentions` name agents on THAT hub only; to involve an agent on another hub,",
    "send a separate reply with that hub. When you refer to a peer across projects, qualify it as",
    "`<hub>/<agent>` (e.g. learn/kb vs cheburnet/kb) so the same name in different projects never",
    "conflates. You are one agent bridging these project rooms.",
  ].join(" ");
  return `${multi} ${BASE_INSTRUCTIONS}`;
}

/**
 * Build the injection notification for an inbound frame (pure). `meta` keys are
 * plain identifiers (letters/digits/underscore) because Claude Code renders them
 * as `<channel>` tag attributes and silently drops non-identifier keys. When
 * `hub` is given (a multi-hub attachment), it's stamped on the tag and the sender
 * is qualified as `<hub>/<agent>` so same-named peers across hubs stay distinct.
 */
export function buildInboundNotification(
  frame: InboundFrame,
  opts: { hub?: string; attachmentPath?: string } = {},
): {
  method: typeof CHANNEL_NOTIFICATION_METHOD;
  params: { content: string; meta: Record<string, string> };
} {
  const { hub, attachmentPath } = opts;
  const m = frame.message;
  const senderLabel = hub ? `${hub}/${m.fromId}` : `agent ${m.fromId}`;
  let content = m.fromKind === "agent" ? `From ${senderLabel}: ${m.text}` : m.text;
  const meta: Record<string, string> = {
    room: m.room,
    from_kind: m.fromKind,
    from_id: m.fromId,
    adapter: m.adapter,
  };
  if (hub) meta.hub = hub;
  if (m.replyTo) {
    // Quoted context the operator pointed you at (a reply-to). Prepend it so the
    // agent catches up without a restatement; expose the author in meta too.
    const who = m.replyTo.author
      ? (hub ? `${hub}/${m.replyTo.author}` : m.replyTo.author)
      : "an earlier message";
    if (m.replyTo.author) meta.reply_to_from = m.replyTo.author;
    content = `↩ In reply to ${who}: "${m.replyTo.text}"\n\n${content}`;
  }
  if (m.mentions.length > 0) meta.mentions = m.mentions.join(",");
  if (frame.coordinationThread) meta.thread = frame.coordinationThread;
  if (m.voice) meta.voice = "true"; // this arrived as a voice note (you may reply in kind)
  if (frame.file) {
    // Always surface an attached file inline (so the agent reliably notices it) and
    // in meta (for tooling) — with its saved path when we could write it locally, or
    // a clear note when we couldn't. Never let a file arrive silently.
    meta.attachment_name = frame.file.filename;
    const note = attachmentPath
      ? `[attachment saved to: ${attachmentPath}]`
      : `[attachment "${frame.file.filename}" received but could not be saved locally]`;
    if (attachmentPath) meta.attachment_path = attachmentPath;
    content = `${content ? `${content}\n\n` : ""}${note}`;
  }
  return { method: CHANNEL_NOTIFICATION_METHOD, params: { content, meta } };
}

/** A parsed `reply`, plus the optional target hub (multi-hub routing). */
export type ReplyArgs = ReplyInput & { hub?: string };

/** Validate and normalize `reply` tool arguments (pure). */
export function parseReplyArgs(args: unknown): ReplyArgs {
  if (typeof args !== "object" || args === null) {
    throw new Error("reply: arguments must be an object");
  }
  const a = args as Record<string, unknown>;
  if (typeof a.room !== "string" || a.room.length === 0) {
    throw new Error("reply: `room` is required");
  }
  if (typeof a.text !== "string" || a.text.length === 0) {
    throw new Error("reply: `text` is required");
  }
  let mentions: string[] | undefined;
  if (a.mentions !== undefined) {
    if (
      !Array.isArray(a.mentions) ||
      a.mentions.some((x) => typeof x !== "string")
    ) {
      throw new Error("reply: `mentions` must be an array of strings");
    }
    mentions = a.mentions as string[];
  }
  if (a.voice !== undefined && typeof a.voice !== "boolean") {
    throw new Error("reply: `voice` must be a boolean");
  }
  if (a.voiceText !== undefined && typeof a.voiceText !== "string") {
    throw new Error("reply: `voiceText` must be a string");
  }
  if (a.hub !== undefined && typeof a.hub !== "string") {
    throw new Error("reply: `hub` must be a string");
  }
  return {
    room: a.room,
    text: a.text,
    mentions,
    // Preserve an explicit `false` — under HUB_TTS_AUTO it opts a reply out of voice.
    ...(a.voice !== undefined ? { voice: a.voice } : {}),
    ...(a.voiceText ? { voiceText: a.voiceText } : {}),
    ...(a.hub ? { hub: a.hub } : {}),
  };
}

export interface SendFileArgs {
  room: string;
  path: string;
  caption?: string;
  mentions?: string[];
  hub?: string;
}

/** Validate and normalize `send_file` tool arguments (pure). */
export function parseSendFileArgs(args: unknown): SendFileArgs {
  if (typeof args !== "object" || args === null) {
    throw new Error("send_file: arguments must be an object");
  }
  const a = args as Record<string, unknown>;
  if (typeof a.room !== "string" || a.room.length === 0) {
    throw new Error("send_file: `room` is required");
  }
  if (typeof a.path !== "string" || a.path.length === 0) {
    throw new Error("send_file: `path` is required");
  }
  if (a.caption !== undefined && typeof a.caption !== "string") {
    throw new Error("send_file: `caption` must be a string");
  }
  let mentions: string[] | undefined;
  if (a.mentions !== undefined) {
    if (!Array.isArray(a.mentions) || a.mentions.some((x) => typeof x !== "string")) {
      throw new Error("send_file: `mentions` must be an array of strings");
    }
    mentions = a.mentions as string[];
  }
  if (a.hub !== undefined && typeof a.hub !== "string") {
    throw new Error("send_file: `hub` must be a string");
  }
  return {
    room: a.room,
    path: a.path,
    ...(a.caption ? { caption: a.caption } : {}),
    ...(mentions ? { mentions } : {}),
    ...(a.hub ? { hub: a.hub } : {}),
  };
}

export interface Channel {
  mcp: Server;
  /** The hub client for `label` (the sole one when single-hub). */
  hub(label?: string): HubLike | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BuildChannelDeps {
  /** Override hub construction (used in tests); called once per hub. */
  createHub?: (cfg: LabeledChannelConfig, events: HubClientEvents) => HubLike;
  channelName?: string;
  logger?: Logger;
}

/**
 * Wire the thin channel: an MCP server whose `reply`/`send_file` tools forward to
 * the hub(s), and whose hub inbound events are injected into the session as
 * `notifications/claude/channel`. With more than one hub in `hubs`, the session
 * attaches to all of them at once — each message namespaced by its `hub` label,
 * each reply routed back to the hub it names (or the room it came from).
 */
export function buildChannel(hubs: LabeledChannelConfig[], deps: BuildChannelDeps = {}): Channel {
  if (hubs.length === 0) throw new Error("buildChannel: at least one hub is required");
  const channelName = deps.channelName ?? DEFAULT_CHANNEL_NAME;
  const log = deps.logger ?? makeLogger(hubs[0].logLevel);
  const multiHub = hubs.length > 1;
  const labels = hubs.map((h) => h.label);
  const maxFileMb = hubs[0].maxFileMb;

  const mcp = new Server(
    { name: channelName, version: "0.0.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: buildInstructions(labels),
    },
  );

  const clients = new Map<string, HubLike>();
  // Which hub a room was last seen on, so a `reply` can omit `hub` and be routed
  // by its `room` (Telegram chat_ids are globally unique, so this can't collide).
  const roomToHub = new Map<string, string>();

  const inject = (frame: InboundFrame, label: string, attachmentPath?: string): void => {
    roomToHub.set(frame.message.room, label);
    const note = buildInboundNotification(frame, {
      ...(multiHub ? { hub: label } : {}),
      ...(attachmentPath ? { attachmentPath } : {}),
    });
    void mcp
      .notification(note as unknown as Parameters<typeof mcp.notification>[0])
      .catch((err: unknown) => {
        log("warn", "failed to inject inbound", { hub: label, error: String(err) });
      });
  };

  const onInbound = (frame: InboundFrame, cfg: LabeledChannelConfig): void => {
    if (!frame.file) {
      inject(frame, cfg.label);
      return;
    }
    // Materialize the bytes to a local path, then inject with that path so the
    // agent can open the file. Namespace the owner by label so same-named agents
    // on different hubs don't collide. If the write fails, still inject.
    const owner = multiHub ? `${cfg.label}-${cfg.agent}` : cfg.agent;
    void materializeInboundFile(owner, frame.file)
      .then((path) => {
        log("info", "saved inbound file", { hub: cfg.label, path, filename: frame.file?.filename });
        inject(frame, cfg.label, path);
      })
      .catch((err: unknown) => {
        log("warn", "failed to save inbound file", { hub: cfg.label, error: String(err) });
        inject(frame, cfg.label);
      });
  };

  for (const cfg of hubs) {
    const events: HubClientEvents = {
      onInbound: (frame) => onInbound(frame, cfg),
      onRegistered: (agent) => log("info", "registered with hub", { hub: cfg.label, agent }),
      onHubError: (code, message, fatal) =>
        log(fatal ? "error" : "warn", "hub error", { hub: cfg.label, code, message, fatal }),
      log,
    };
    clients.set(cfg.label, deps.createHub ? deps.createHub(cfg, events) : new HubClient(cfg, events));
  }

  /** Resolve which hub a reply/send_file targets, or an error message to return. */
  const resolveHub = (explicit: string | undefined, room: string): { label: string } | { error: string } => {
    if (explicit !== undefined) {
      if (clients.has(explicit)) return { label: explicit };
      return { error: `unknown hub "${explicit}" — known hubs: ${labels.join(", ")}` };
    }
    if (!multiHub) return { label: labels[0] };
    const inferred = roomToHub.get(room);
    if (inferred) return { label: inferred };
    return { error: `attached to multiple hubs — pass \`hub\` (one of: ${labels.join(", ")})` };
  };

  const hubField = {
    hub: {
      type: "string",
      description: `Which hub to send into — the \`hub\` attribute from the <channel> tag (required when attached to multiple hubs: ${labels.join(", ")}).`,
    },
  };

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "reply",
        description: "Send a message back out through the hub to the room it came from.",
        inputSchema: {
          type: "object" as const,
          properties: {
            room: {
              type: "string",
              description: "Room to reply into — the `room` attribute from the <channel> tag.",
            },
            text: { type: "string", description: "The message text to send." },
            mentions: {
              type: "array",
              items: { type: "string" },
              description: "Agent names to tag for agent-to-agent coordination (names on the target hub).",
            },
            voice: {
              type: "boolean",
              description:
                "Also send this reply as a voice note. Use for a short, spoken-appropriate message — a gist + next action, a couple of sentences — especially when replying to a voice message. Write `text` for the ear: expand abbreviations, keep hex/IPs/code/links/exact-values out. It must stay under the hub's character cap and be speakable; code, links, lists, or long text can't be voiced and post as text. The tool result tells you whether it went out as voice or fell back to text (and why), so you can shorten and re-send if needed. If this hub auto-voices replies, set `voice: false` to force this one to stay text.",
            },
            voiceText: {
              type: "string",
              description:
                "Optional: the exact words to speak when `voice` is set, if the natural spoken form differs from the displayed `text` — e.g. display \"deployed abc123, logs at <link>\" but say \"deployed to prod\". When omitted, the hub speaks a sanitized `text`. `text` stays the caption; `voiceText` is still subject to the length/speakability limits.",
            },
            ...(multiHub ? hubField : {}),
          },
          required: ["room", "text"],
        },
      },
      {
        name: "send_file",
        description:
          "Send a local file or image out through the hub to a room. Provide the room and an absolute local path; add an optional caption. To hand the file to peer agents (not just the operator), list their names in `mentions` — each receives the file at a local path.",
        inputSchema: {
          type: "object" as const,
          properties: {
            room: {
              type: "string",
              description: "Room to send into — the `room` attribute from the <channel> tag.",
            },
            path: { type: "string", description: "Absolute path to the local file to send." },
            caption: { type: "string", description: "Optional caption to accompany the file." },
            mentions: {
              type: "array",
              items: { type: "string" },
              description:
                "Peer agent names to deliver the file to (agent-to-agent handoff). Each tagged agent receives it as an inbound with the file saved to a local path. Without this, the file only posts to the room for the operator — peer agents won't get the bytes.",
            },
            ...(multiHub ? hubField : {}),
          },
          required: ["room", "path"],
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "reply") {
      const reply = parseReplyArgs(req.params.arguments);
      const target = resolveHub(reply.hub, reply.room);
      if ("error" in target) return { content: [{ type: "text", text: `reply: ${target.error}` }] };
      const client = clients.get(target.label);
      if (!client) return { content: [{ type: "text", text: `reply: no client for hub "${target.label}"` }] };
      client.sendReply(reply);
      log("info", "reply sent to hub", { hub: target.label, room: reply.room });

      const suffix = multiHub ? ` (hub ${target.label})` : "";
      const caps = client.voiceReplyCaps();
      if (reply.voice && caps) {
        const outcome = checkVoiceReply(reply.voiceText ?? reply.text, caps);
        if (!outcome.voiced) {
          log("info", "voiced reply will post as text", { hub: target.label, reason: outcome.reason });
          return {
            content: [{ type: "text", text: `delivered to hub${suffix}, but NOT as a voice note — ${outcome.reason}` }],
          };
        }
        return { content: [{ type: "text", text: `delivered to hub${suffix} (as a voice note)` }] };
      }
      return { content: [{ type: "text", text: `delivered to hub${suffix}` }] };
    }
    if (req.params.name === "send_file") {
      const args = parseSendFileArgs(req.params.arguments);
      const target = resolveHub(args.hub, args.room);
      if ("error" in target) return { content: [{ type: "text", text: `send_file: ${target.error}` }] };
      const client = clients.get(target.label);
      if (!client) return { content: [{ type: "text", text: `send_file: no client for hub "${target.label}"` }] };
      const file = await readOutboundFile(args.path, maxFileMb * MB);
      client.sendFile({
        room: args.room,
        file,
        ...(args.caption ? { caption: args.caption } : {}),
        ...(args.mentions ? { mentions: args.mentions } : {}),
      });
      log("info", "file sent to hub", {
        hub: target.label,
        room: args.room,
        filename: file.filename,
        mentions: args.mentions?.length ?? 0,
      });
      const hubSuffix = multiHub ? ` (hub ${target.label})` : "";
      const toPeers =
        args.mentions && args.mentions.length > 0 ? ` and handed to ${args.mentions.join(", ")}` : "";
      return {
        content: [{ type: "text", text: `sent ${file.filename} to hub${hubSuffix}${toPeers}` }],
      };
    }
    throw new Error(`unknown tool: ${req.params.name}`);
  });

  return {
    mcp,
    hub: (label) => (label ? clients.get(label) : clients.get(labels[0])),
    async start() {
      await mcp.connect(new StdioServerTransport());
      log("info", "channel started", { channelName, hubs: labels });
      for (const client of clients.values()) client.start();
    },
    async stop() {
      for (const client of clients.values()) client.stop();
      await mcp.close();
    },
  };
}
