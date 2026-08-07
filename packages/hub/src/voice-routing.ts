import { isBroadcastMention } from "@claude-telegram-hub/protocol";

/** Words that join names in an address ("platform and gitops"), EN + a little RU. */
const CONNECTORS = new Set(["and", "und", "и", "plus"]);

/** Spoken broadcast keywords, EN + a little RU. `@all`-style aliases are also honored. */
const BROADCAST_WORDS = new Set(["all", "everyone", "everybody", "team", "все", "всем"]);

/** Below this length a token is too short to trust as a name match (skips "re", "a"). */
const MIN_NAME_TOKEN = 3;

/** How many leading tokens to scan for an address before giving up. */
const MAX_SCAN = 8;

export interface SpokenRecipients {
  recipients: string[];
  broadcast: boolean;
}

function normalize(s: string): string {
  // Fold to comparable form: lowercase, drop everything but letters/digits
  // (handles "re-infra" vs "re infra", trailing punctuation, cyrillic).
  return s.toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]/gi, "");
}

/**
 * Resolve who a *voice* note is addressed to from its transcript, since speech
 * carries no `@tags`. People open by naming who they're talking to, then speak —
 * so only the **leading run** of the transcript is treated as the address:
 * consecutive agent-name matches and connectors ("and"), until the first token
 * that's neither (that's where the message starts). "Platform, ask gitops about X"
 * is therefore unicast to platform — the mid-sentence "gitops" is content, not a
 * recipient. A leading broadcast word ("everyone") sets `broadcast`.
 *
 * Matching is generous-but-bounded (so awkward repo-basename agent names like
 * `re-infra` match a natural "infra"): normalized substring either way, min token
 * length. Always echoed by the caller, so a stray match is caught before agents act.
 */
export function resolveSpokenRecipients(transcript: string, roster: string[]): SpokenRecipients {
  const normRoster = roster.map((agent) => ({ agent, norm: normalize(agent) }));
  const recipients: string[] = [];
  let broadcast = false;

  const tokens = transcript.trim().split(/\s+/).slice(0, MAX_SCAN);
  for (const raw of tokens) {
    const t = normalize(raw);
    if (t === "") continue; // pure punctuation (e.g. a lone comma)
    if (BROADCAST_WORDS.has(t) || isBroadcastMention(t)) {
      broadcast = true;
      continue;
    }
    if (CONNECTORS.has(t)) continue;
    const match = normRoster.find(
      ({ norm }) => t.length >= MIN_NAME_TOKEN && (norm.includes(t) || t.includes(norm)),
    );
    if (match) {
      if (!recipients.includes(match.agent)) recipients.push(match.agent);
      continue;
    }
    break; // first non-address token — the message body begins here
  }

  return { recipients, broadcast };
}
