import telegramify from "telegramify-markdown";
import type { OutboundMessage } from "@claude-telegram-hub/protocol";

/**
 * Render an outbound message to Telegram **MarkdownV2**. Agents emit CommonMark
 * (`**bold**`, `` `code` ``, `- lists`), which Telegram won't render as plain
 * text; `telegramify-markdown` converts it to MarkdownV2 and escapes every
 * special character so Telegram accepts the entities. Replies are prefixed with
 * the bold speaking-agent name (attribution); notices pass through.
 */
export function toTelegramMarkdown(out: OutboundMessage): string {
  const markdown =
    out.kind === "notice" ? out.text : `**${out.agent}** ▸ ${out.text}`;
  return telegramify(markdown, "escape");
}
