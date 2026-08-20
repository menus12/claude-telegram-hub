import type { Session } from "./session.js";

/**
 * Maps agent name ↔ live session. One session per agent name; when an agent
 * re-registers (e.g. the session restarted), the new connection replaces the
 * old one — the displaced session is returned so the caller can close it. This
 * lets a session restart and re-attach without disturbing other agents.
 */
export class AgentRegistry {
  private readonly byName = new Map<string, Session>();

  /** Register a session, returning any previous session it displaced. */
  register(session: Session): Session | undefined {
    const previous = this.byName.get(session.agent);
    this.byName.set(session.agent, session);
    return previous;
  }

  /**
   * Remove a session — but only if it is still the current one for its agent.
   * A late close() from a displaced connection must not evict the newer one.
   */
  unregister(session: Session): void {
    if (this.byName.get(session.agent) === session) {
      this.byName.delete(session.agent);
    }
  }

  get(agent: string): Session | undefined {
    return this.byName.get(agent);
  }

  has(agent: string): boolean {
    return this.byName.has(agent);
  }

  list(): string[] {
    return [...this.byName.keys()];
  }

  /** Live registrations with their session metadata, for the `/who` roster (#99). */
  entries(): { agent: string; id: number; connectedAt: number }[] {
    return [...this.byName.values()].map((s) => ({
      agent: s.agent,
      id: s.id,
      connectedAt: s.connectedAt,
    }));
  }
}
