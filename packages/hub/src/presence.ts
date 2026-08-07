import { presenceOfflineNotice, presenceOnlineNotice } from "@claude-telegram-hub/protocol";
import type { OutboundMessage } from "@claude-telegram-hub/protocol";
import { realScheduler, type Scheduler } from "./scheduler.js";

export interface PresenceTrackerOptions {
  /**
   * Grace window (ms) a dropped session may reconnect within before the agent is
   * announced offline. Absorbs restart churn (a reconnect cancels the offline).
   */
  graceMs: number;
  /** Post a presence notice (the hub delivers it to each configured room). */
  emit: (notice: OutboundMessage) => void;
  /** Whether `agent` currently has a live session (a newer one may have replaced it). */
  isLive: (agent: string) => boolean;
  /** Injectable timer; defaults to `setTimeout`/`clearTimeout`. */
  schedule?: Scheduler;
}

/**
 * Debounced online/offline presence for the room. Sessions churn — a restart does
 * a displace-then-detach, and the channel reconnects on backoff — so raw
 * register/detach events would flap. This tracker announces:
 *
 *   - **online** only on an agent's *first* live registration. A re-register of an
 *     already-online agent (the displace half of a restart, or a reconnect within
 *     the grace window) is silent.
 *   - **offline** only after `graceMs` elapses with no live session for that agent.
 *     A reconnect within the window cancels the pending offline, so restart churn
 *     never surfaces.
 *
 * State lives here, independent of the registry, so the two churn shapes collapse
 * to at most one online and one offline notice per real presence change.
 */
export class PresenceTracker {
  /** Agents currently considered online (an online notice has been emitted). */
  private readonly online = new Set<string>();
  /** Agents whose session dropped and are within the grace window: name → cancel. */
  private readonly pendingOffline = new Map<string, () => void>();
  private readonly schedule: Scheduler;

  constructor(private readonly opts: PresenceTrackerOptions) {
    this.schedule = opts.schedule ?? realScheduler;
  }

  /** A session for `agent` just registered. */
  onConnect(agent: string): void {
    const cancelOffline = this.pendingOffline.get(agent);
    if (cancelOffline) {
      // Reconnected within the grace window — it never actually went offline.
      cancelOffline();
      this.pendingOffline.delete(agent);
      return;
    }
    if (this.online.has(agent)) return; // already online (re-register/displace) — no repeat
    this.online.add(agent);
    this.opts.emit(presenceOnlineNotice(agent));
  }

  /** A session for `agent` just detached. */
  onDetach(agent: string): void {
    if (!this.online.has(agent)) return; // never announced online — nothing to retract
    if (this.opts.isLive(agent)) return; // a newer session remains (displaced) — ignore
    if (this.pendingOffline.has(agent)) return; // already counting down
    const cancel = this.schedule(() => {
      this.pendingOffline.delete(agent);
      if (this.opts.isLive(agent)) return; // reconnected right at the edge — stay online
      this.online.delete(agent);
      this.opts.emit(presenceOfflineNotice(agent));
    }, this.opts.graceMs);
    this.pendingOffline.set(agent, cancel);
  }

  /** Cancel all pending offline timers (hub shutdown). */
  stop(): void {
    for (const cancel of this.pendingOffline.values()) cancel();
    this.pendingOffline.clear();
  }
}
