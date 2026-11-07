import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Per-environment bearer tokens. Each cloud environment gets its own token, set as
 * a *network secret* in that environment, so the proxy injects it outside the VM
 * and the session never holds it. The bridge stores only `label sha256hex` pairs:
 * the label names the environment in logs and rate limits; the token itself is
 * never stored or logged here.
 */
export interface TokenEntry {
  label: string;
  sha256: Buffer;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Parse a tokens file: `label sha256hex` per line; blank lines and `#` comments ignored. */
export function parseTokens(text: string): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const labels = new Set<string>();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const [label, hash, ...rest] = line.split(/\s+/);
    if (!label || !hash || rest.length > 0 || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error(`tokens file line ${i + 1}: expected "label sha256hex"`);
    }
    if (labels.has(label)) throw new Error(`tokens file line ${i + 1}: duplicate label "${label}"`);
    labels.add(label);
    entries.push({ label, sha256: Buffer.from(hash.toLowerCase(), "hex") });
  });
  if (entries.length === 0) throw new Error("tokens file has no entries");
  return entries;
}

export class TokenStore {
  constructor(private readonly entries: TokenEntry[]) {}

  /** The label of the token in an `Authorization: Bearer …` header, or undefined. */
  verify(authorization: string | undefined): string | undefined {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const token = authorization.slice("Bearer ".length).trim();
    if (token.length === 0) return undefined;
    const digest = createHash("sha256").update(token).digest();
    let match: string | undefined;
    // Compare against every entry (constant work regardless of which one matches).
    for (const e of this.entries) {
      if (timingSafeEqual(digest, e.sha256) && match === undefined) match = e.label;
    }
    return match;
  }
}
