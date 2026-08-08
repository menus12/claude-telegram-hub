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
 * True if `a` and `b` are within `max` edits, counting an adjacent transposition as
 * one (Damerau / optimal string alignment) — transpositions like `platfrom` are a
 * common transcription slip. Small strings, so a full matrix is fine.
 */
function withinEditDistance(a: string, b: string, max: number): boolean {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return false;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // adjacent transposition
      }
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return false; // no row can lead to ≤ max
  }
  return d[n][m] <= max;
}

/**
 * Match a spoken token to an agent, tolerantly (short repo names transcribe badly):
 *  1. exact normalized equality — any length, so a 2-char name like `kb` matches;
 *  2. substring either way (len ≥ 3) — `con` → `conn`, `kb123` → `kb`;
 *  3. one edit's distance (len ≥ 4) — catches a typo/phonetic near-miss like
 *     `platfrom` → `platform`.
 * STT prompt-biasing (feeding the roster to Whisper) fixes most cases upstream; this
 * mops up the rest, and every match is shown in the transcript echo before agents act.
 */
function matchAgent(token: string, roster: { agent: string; norm: string }[]): string | undefined {
  for (const a of roster) if (a.norm === token) return a.agent;
  if (token.length < MIN_NAME_TOKEN) return undefined;
  for (const a of roster) if (a.norm.includes(token) || token.includes(a.norm)) return a.agent;
  if (token.length >= 4) {
    for (const a of roster) {
      if (a.norm.length >= 4 && withinEditDistance(a.norm, token, 1)) return a.agent;
    }
  }
  return undefined;
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
    const agent = matchAgent(t, normRoster);
    if (agent) {
      if (!recipients.includes(agent)) recipients.push(agent);
      continue;
    }
    break; // first non-address token — the message body begins here
  }

  return { recipients, broadcast };
}
