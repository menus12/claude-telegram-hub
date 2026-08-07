import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
  if (attachmentPath) {
    // Surface the saved file both as a meta attribute (for tooling) and inline
    // (so the agent reliably notices it), mirroring the official plugin.
    meta.attachment_path = attachmentPath;
    content = `${content ? `${content}\n\n` : ""}[attachment saved to: ${attachmentPath}]`;
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
  return { room: a.room, text: a.text, mentions };
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
      // agent can open the file. If the write fails, still inject the message.
      void materializeInboundFile(cfg.agent, frame.file)
        .then((path) => inject(frame, path))
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
