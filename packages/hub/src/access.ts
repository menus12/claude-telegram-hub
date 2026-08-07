import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./logger.js";

/** The in-chat allowlist commands the hub understands. */
export const KNOWN_COMMANDS = new Set(["start", "allow", "deny", "allowlist", "pending"]);

export interface ParsedCommand {
  name: string;
  args: string[];
}

/**
 * Parse a leading-slash command from message text, e.g. `/allow 123` or the
 * group form `/allow@mybot 123`. Returns `null` when the text isn't a command.
 * The caller decides which names to act on, so a non-command slash message (e.g.
 * `/deploy @agent …`) falls through to normal routing rather than being eaten.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(.*)$/.exec(text.trim());
  if (!m) return null;
  const rest = m[2].trim();
  return { name: m[1].toLowerCase(), args: rest ? rest.split(/\s+/) : [] };
}

interface PersistShape {
  allow: string[];
  denied: string[];
  pending: string[];
}

export interface AccessControllerOptions {
  /** Seed allowlist from `HUB_ALLOWLIST` (always allowed unless explicitly denied). */
  seed: string[];
  /** Admin ids permitted to mutate the allowlist. */
  admins: string[];
  /** Optional JSON file persisting runtime changes; unset = in-memory only. */
  stateFile?: string;
  logger?: Logger;
}

/**
 * The hub's access policy: who may talk to it, who may administer it, and the
 * pending-approval queue. The effective allowlist is the env **seed** plus any
 * runtime-added ids, minus any denied ids — so the seed stays declarative while
 * `/allow` and `/deny` layer on top. Runtime state is persisted to `stateFile`
 * (when configured) so it survives a restart; the seed is re-applied on load, so
 * changing `HUB_ALLOWLIST` between restarts still takes effect.
 */
export class AccessController {
  private readonly seed: Set<string>;
  private readonly admins: Set<string>;
  private readonly allow = new Set<string>();
  private readonly denied = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly stateFile: string | undefined;
  private readonly logger: Logger | undefined;

  constructor(opts: AccessControllerOptions) {
    this.seed = new Set(opts.seed);
    this.admins = new Set(opts.admins);
    this.stateFile = opts.stateFile;
    this.logger = opts.logger;
    this.load();
    this.verifyWritable();
  }

  isAllowed(id: string): boolean {
    return (this.seed.has(id) || this.allow.has(id)) && !this.denied.has(id);
  }

  isAdmin(id: string): boolean {
    return this.admins.has(id);
  }

  adminIds(): string[] {
    return [...this.admins];
  }

  /** Grant access to `id` (clears any deny/pending). Persisted. */
  allowUser(id: string): void {
    this.allow.add(id);
    this.denied.delete(id);
    this.pending.delete(id);
    this.persist();
  }

  /** Revoke access from `id` — overrides the seed too. Persisted. */
  denyUser(id: string): void {
    this.denied.add(id);
    this.allow.delete(id);
    this.pending.delete(id);
    this.persist();
  }

  /** Queue an unknown sender for approval; returns true if newly added. */
  addPending(id: string): boolean {
    if (this.isAllowed(id) || this.pending.has(id)) return false;
    this.pending.add(id);
    this.persist();
    return true;
  }

  listAllowed(): string[] {
    return [...new Set([...this.seed, ...this.allow])]
      .filter((id) => !this.denied.has(id))
      .sort();
  }

  listPending(): string[] {
    return [...this.pending].sort();
  }

  private load(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<PersistShape>;
      for (const id of raw.allow ?? []) this.allow.add(id);
      for (const id of raw.denied ?? []) this.denied.add(id);
      for (const id of raw.pending ?? []) this.pending.add(id);
    } catch (err) {
      this.logger?.("warn", "failed to load access state", { error: String(err) });
    }
  }

  private writeState(): void {
    if (!this.stateFile) return;
    const data: PersistShape = {
      allow: [...this.allow],
      denied: [...this.denied],
      pending: [...this.pending],
    };
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
  }

  private persist(): void {
    if (!this.stateFile) return;
    try {
      this.writeState();
    } catch (err) {
      this.logger?.("warn", "failed to persist access state", { error: String(err) });
    }
  }

  /**
   * At boot, confirm `HUB_STATE_FILE` is actually writable by materializing it.
   * If it isn't (a common misconfig: a read-only mount, or an Azure Files / Docker
   * volume not writable by the container's non-root uid), fail *loudly* — otherwise
   * `/allow` would appear to work but every runtime change would be lost on the next
   * restart, which is exactly when the operator is relying on it.
   */
  private verifyWritable(): void {
    if (!this.stateFile) return;
    try {
      this.writeState();
    } catch (err) {
      this.logger?.(
        "error",
        `HUB_STATE_FILE (${this.stateFile}) is not writable — runtime allowlist changes ` +
          `will be LOST on restart. Ensure the mount exists and is writable by the ` +
          `container user (uid 1000).`,
        { error: String(err) },
      );
    }
  }
}
