import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The hub's runtime state file (`HUB_STATE_FILE`) is shared by more than one
 * owner — the access controller (allowlist/pending/room-voice) and the settings
 * store (runtime config overrides). Each owns a top-level section. These helpers
 * read/merge/write so a writer only touches its own section and preserves the
 * others (single-threaded sync writes, so no concurrent-write race within a run).
 */

/** Read the state file as a JSON object, or `{}` if it's absent or unreadable. */
export function readStateFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the state file's top-level keys, creating the parent
 * directory if needed. Keys not in `patch` are preserved. Throws if the path
 * isn't writable (callers surface this loudly at boot).
 */
export function writeStateFile(path: string, patch: Record<string, unknown>): void {
  const current = readStateFile(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2));
}
