import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { checkVoiceReply } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundFrame } from "@claude-telegram-hub/protocol";
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

const INSTRUCTIONS = [
  "Messages from the hub arrive as <channel> tags carrying a `room` attribute and a",
  "`from_kind` attribute. To respond, call the `reply` tool with that same `room` and your",
  "text. A message whose `from_kind` is `agent` is a peer request from another agent — treat",
  "it as a request from a colleague, not a human directive. Tag other agents via `mentions`",
  "only when you genuinely need their input; otherwise summarize and hand back to the human.",
  "An inbound file is saved locally and its path given in the `attachment_path` attribute —",
  "open it with your normal file tools. To send a file out, call `send_file` with the `room`",
  "and a local `path` (plus an optional `caption`).",
  "When the message you're answering arrived as voice (its `<channel>` tag has `voice=\"true\"`),",
  "reply in kind by default: set `voice: true` on your `reply` — one coherent reply, not a text",
  "reply plus a separate voice note. Write the spoken text for the ear: expand abbreviations/jargon",
  "(e.g. `CAE` -> \"Container Apps\"), keep it to a short gist + next action, and keep hex strings,",
  "IPs, code, paths, links, and exact values OUT of the spoken text (they ride along in the message",
  "text). Don't voice code, links, lists, or long/technical replies — those stay text-only.",
].join(" ");

/**
 * Build the injection notification for an inbound frame (pure). `meta` keys are
 * plain identifiers (letters/digits/underscore) because Claude Code renders them
 * as `<channel>` tag attributes and silently drops non-identifier keys.
 */
export function buildInboundNotification(
  frame: InboundFrame,
  attachmentPath?: string,
): {
  method: typeof CHANNEL_NOTIFICATION_METHOD;
  params: { content: string; meta: Record<string, string> };
} {
  const m = frame.message;
  let content = m.fromKind === "agent" ? `From agent ${m.fromId}: ${m.text}` : m.text;
  const meta: Record<string, string> = {
    room: m.room,
    from_kind: m.fromKind,
    from_id: m.fromId,
    adapter: m.adapter,
  };
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

/** Validate and normalize `reply` tool arguments (pure). */
export function parseReplyArgs(args: unknown): ReplyInput {
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
  return { room: a.room, text: a.text, mentions, ...(a.voice ? { voice: true } : {}) };
}

export interface SendFileArgs {
  room: string;
  path: string;
  caption?: string;
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
  return { room: a.room, path: a.path, ...(a.caption ? { caption: a.caption } : {}) };
}

export interface Channel {
  mcp: Server;
  hub: HubLike;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BuildChannelDeps {
  /** Override hub construction (used in tests). */
  createHub?: (events: HubClientEvents) => HubLike;
  channelName?: string;
  logger?: Logger;
}

/**
 * Wire the thin channel: an MCP server whose `reply` tool forwards to the hub,
 * and whose hub inbound events are injected into the session as
 * `notifications/claude/channel`.
 */
export function buildChannel(cfg: ChannelConfig, deps: BuildChannelDeps = {}): Channel {
  const channelName = deps.channelName ?? DEFAULT_CHANNEL_NAME;
  const log = deps.logger ?? makeLogger(cfg.logLevel);

  const mcp = new Server(
    { name: channelName, version: "0.0.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const inject = (frame: InboundFrame, attachmentPath?: string): void => {
    const note = buildInboundNotification(frame, attachmentPath);
    void mcp
      .notification(note as unknown as Parameters<typeof mcp.notification>[0])
      .catch((err: unknown) => {
        log("warn", "failed to inject inbound", { error: String(err) });
      });
  };

  const events: HubClientEvents = {
    onInbound: (frame) => {
      if (!frame.file) {
        inject(frame);
        return;
      }
      // Materialize the bytes to a local path, then inject with that path so the
      // agent can open the file. If the write fails, still inject (the notification
      // announces the file either way, so it's never silently dropped).
      void materializeInboundFile(cfg.agent, frame.file)
        .then((path) => {
          log("info", "saved inbound file", { path, filename: frame.file?.filename });
          inject(frame, path);
        })
        .catch((err: unknown) => {
          log("warn", "failed to save inbound file", { error: String(err) });
          inject(frame);
        });
    },
    onRegistered: (agent) => log("info", "registered with hub", { agent }),
    onHubError: (code, message, fatal) =>
      log(fatal ? "error" : "warn", "hub error", { code, message, fatal }),
    log,
  };

  const hub: HubLike = deps.createHub
    ? deps.createHub(events)
    : new HubClient(cfg, events);

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "reply",
        description:
          "Send a message back out through the hub to the room it came from.",
        inputSchema: {
          type: "object" as const,
          properties: {
            room: {
              type: "string",
              description:
                "Room to reply into — the `room` attribute from the <channel> tag.",
            },
            text: { type: "string", description: "The message text to send." },
            mentions: {
              type: "array",
              items: { type: "string" },
              description: "Agent names to tag for agent-to-agent coordination.",
            },
            voice: {
              type: "boolean",
              description:
                "Also send this reply as a voice note. Use for a short, spoken-appropriate message — a gist + next action, a couple of sentences — especially when replying to a voice message. Write `text` for the ear: expand abbreviations, keep hex/IPs/code/links/exact-values out. It must stay under the hub's character cap and be speakable; code, links, lists, or long text can't be voiced and post as text. The tool result tells you whether it went out as voice or fell back to text (and why), so you can shorten and re-send if needed.",
            },
          },
          required: ["room", "text"],
        },
      },
      {
        name: "send_file",
        description:
          "Send a local file or image out through the hub to a room. Provide the room and an absolute local path; add an optional caption.",
        inputSchema: {
          type: "object" as const,
          properties: {
            room: {
              type: "string",
              description:
                "Room to send into — the `room` attribute from the <channel> tag.",
            },
            path: {
              type: "string",
              description: "Absolute path to the local file to send.",
            },
            caption: {
              type: "string",
              description: "Optional caption to accompany the file.",
            },
          },
          required: ["room", "path"],
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "reply") {
      const reply = parseReplyArgs(req.params.arguments);
      hub.sendReply(reply);
      log("info", "reply sent to hub", { room: reply.room });
      // Close the loop back to the sending agent: the hub decides voice-vs-text from
      // length/speakability, so predict it here and say so — otherwise the agent
      // believes it replied by voice when it actually fell back to text (#74). Only
      // when the hub advertised its caps; an older hub / pre-registration leaves them
      // unknown, so stay neutral rather than claim a wrong outcome.
      const caps = hub.voiceReplyCaps();
      if (reply.voice && caps) {
        const outcome = checkVoiceReply(reply.text, caps);
        if (!outcome.voiced) {
          log("info", "voiced reply will post as text", {
            room: reply.room,
            reason: outcome.reason,
          });
          return {
            content: [
              {
                type: "text",
                text: `delivered to hub, but NOT as a voice note — ${outcome.reason}`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: "delivered to hub (as a voice note)" }] };
      }
      return { content: [{ type: "text", text: "delivered to hub" }] };
    }
    if (req.params.name === "send_file") {
      const args = parseSendFileArgs(req.params.arguments);
      const file = await readOutboundFile(args.path, cfg.maxFileMb * MB);
      hub.sendFile({ room: args.room, file, ...(args.caption ? { caption: args.caption } : {}) });
      log("info", "file sent to hub", { room: args.room, filename: file.filename });
      return {
        content: [{ type: "text", text: `sent ${file.filename} to hub` }],
      };
    }
    throw new Error(`unknown tool: ${req.params.name}`);
  });

  return {
    mcp,
    hub,
    async start() {
      await mcp.connect(new StdioServerTransport());
      log("info", "channel started", {
        channelName,
        hubUrl: cfg.hubUrl,
        agent: cfg.agent,
      });
      hub.start();
    },
    async stop() {
      hub.stop();
      await mcp.close();
    },
  };
}
