// `parseMentions` now lives in the protocol package so the hub core can reuse it
// for agent-reply @-tag routing (symmetric with human @-parsing). Re-exported here
// to keep the adapter's existing import path stable.
export { parseMentions } from "@claude-telegram-hub/protocol";
