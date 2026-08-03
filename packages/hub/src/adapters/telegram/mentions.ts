function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract agent mentions from message text for a configurable sigil (default
 * `@`). A mention is the sigil at a word boundary followed by an agent-name
 * token (`A–Z a–z 0–9 _ -`). Requiring a leading boundary means an email like
 * `user@re-infra` is not treated as a mention. Order-preserving + de-duplicated.
 */
export function parseMentions(text: string, sigil: string): string[] {
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(sigil)}([A-Za-z0-9_-]+)`, "g");
  const found: string[] = [];
  for (const match of text.matchAll(re)) {
    const name = match[1];
    if (!found.includes(name)) found.push(name);
  }
  return found;
}
