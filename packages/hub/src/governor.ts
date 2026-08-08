export interface GovernorDecision {
  /** Whether this agent→agent hop may be re-injected. */
  allowed: boolean;
  /** Whether this hop just exhausted the budget (post the freeze notice once). */
  froze: boolean;
}

/**
 * The hard loop backstop. Guarantees no infinite agent↔agent chain regardless of
 * model behavior, without touching human→agent delivery.
 *
 * A **coordination thread** is scoped to a room. A human message tagging agents
 * (re)opens the thread at the full hop budget; each agent→agent re-injection in
 * that room consumes one hop; at zero the thread freezes and agent→agent routing
 * is suppressed until a human message refills it (human presence = license to
 * continue). The hop that drives the budget to zero is still delivered — it's the
 * *next* one that's blocked — so a budget of N permits N hops before the freeze.
 */
export class LoopGovernor {
  private readonly threads = new Map<string, { budget: number; frozen: boolean }>();

  constructor(private fullBudget: number) {}

  /** Change the hop budget at runtime; applies to threads opened/refilled after. */
  reconfigure(fullBudget: number): void {
    this.fullBudget = fullBudget;
  }

  /** A human message in this room (re)opens the thread at full budget. */
  refill(room: string): void {
    this.threads.set(room, { budget: this.fullBudget, frozen: false });
  }

  /**
   * Account for an agent→agent hop about to be re-injected in this room. Returns
   * whether it's allowed and whether it just froze the thread.
   */
  onAgentHop(room: string): GovernorDecision {
    const thread = this.threads.get(room) ?? {
      budget: this.fullBudget,
      frozen: false,
    };
    this.threads.set(room, thread);

    if (thread.frozen) return { allowed: false, froze: false };

    thread.budget -= 1;
    if (thread.budget <= 0) {
      thread.frozen = true;
      return { allowed: true, froze: true };
    }
    return { allowed: true, froze: false };
  }

  isFrozen(room: string): boolean {
    return this.threads.get(room)?.frozen ?? false;
  }

  /** Remaining hops for a room (full budget if no thread is open yet). */
  budget(room: string): number {
    return this.threads.get(room)?.budget ?? this.fullBudget;
  }
}
