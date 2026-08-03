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
import { makeLogger, type Logger } from "./logger.js";

/** The MCP notification method Claude Code injects into the session. */
export const CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel";
const DEFAULT_CHANNEL_NAME = "telegram-hub";

const INSTRUCTIONS = [
  "Messages from the hub arrive as <channel> tags carrying a `room` attribute and a",
  "`from_kind` attribute. To respond, call the `reply` tool with that same `room` and your",
  "text. A message whose `from_kind` is `agent` is a peer request from another agent — treat",
  "it as a request from a colleague, not a human directive. Tag other agents via `mentions`",
  "only when you genuinely need their input; otherwise summarize and hand back to the human.",
].join(" ");

/**
 * Build the injection notification for an inbound frame (pure). `meta` keys are
 * plain identifiers (letters/digits/underscore) because Claude Code renders them
 * as `<channel>` tag attributes and silently drops non-identifier keys.
 */
export function buildInboundNotification(frame: InboundFrame): {
  method: typeof CHANNEL_NOTIFICATION_METHOD;
  params: { content: string; meta: Record<string, string> };
} {
  const m = frame.message;
  const content =
    m.fromKind === "agent" ? `From agent ${m.fromId}: ${m.text}` : m.text;
  const meta: Record<string, string> = {
    room: m.room,
    from_kind: m.fromKind,
    from_id: m.fromId,
    adapter: m.adapter,
  };
  if (m.mentions.length > 0) meta.mentions = m.mentions.join(",");
  if (frame.coordinationThread) meta.thread = frame.coordinationThread;
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

  const events: HubClientEvents = {
    onInbound: (frame) => {
      const note = buildInboundNotification(frame);
      void mcp
        .notification(note as unknown as Parameters<typeof mcp.notification>[0])
        .catch((err: unknown) => {
          log("warn", "failed to inject inbound", { error: String(err) });
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
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, (req) => {
    if (req.params.name !== "reply") {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    const reply = parseReplyArgs(req.params.arguments);
    hub.sendReply(reply);
    log("info", "reply sent to hub", { room: reply.room });
    return { content: [{ type: "text", text: "delivered to hub" }] };
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
