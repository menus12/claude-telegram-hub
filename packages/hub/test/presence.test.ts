import { describe, it, expect } from "vitest";
import { PresenceTracker, type Scheduler } from "../src/presence.js";

/** A controllable scheduler: nothing fires until `flush()` (grace elapsed). */
class FakeScheduler {
  private pending = new Map<number, () => void>();
  private nextId = 0;

  readonly schedule: Scheduler = (fn) => {
    const id = this.nextId++;
    this.pending.set(id, fn);
    return () => this.pending.delete(id);
  };

  /** Fire every pending timer (as if the grace window elapsed). */
  flush(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }

  get size(): number {
    return this.pending.size;
  }
}

/** Test harness: a tracker whose `isLive` mirrors a `live` set the test controls. */
function harness(graceMs = 1000) {
  const live = new Set<string>();
  const emitted: string[] = [];
  const sched = new FakeScheduler();
  const tracker = new PresenceTracker({
    graceMs,
    isLive: (a) => live.has(a),
    emit: (n) => emitted.push(n.text),
    schedule: sched.schedule,
  });
  return { live, emitted, sched, tracker };
}

describe("PresenceTracker", () => {
  it("announces online on the first connect", () => {
    const { live, emitted, tracker } = harness();
    live.add("re-infra");
    tracker.onConnect("re-infra");
    expect(emitted).toEqual(["@re-infra is online."]);
  });

  it("does not repeat online on a re-register of an already-online agent", () => {
    const { live, emitted, tracker } = harness();
    live.add("re-infra");
    tracker.onConnect("re-infra");
    tracker.onConnect("re-infra"); // displace half of a restart — still live
    expect(emitted).toEqual(["@re-infra is online."]);
  });

  it("announces offline only after the grace window elapses", () => {
    const { live, emitted, sched, tracker } = harness();
    live.add("re-infra");
    tracker.onConnect("re-infra");

    live.delete("re-infra");
    tracker.onDetach("re-infra");
    expect(sched.size).toBe(1); // scheduled, not yet announced
    expect(emitted).toEqual(["@re-infra is online."]);

    sched.flush();
    expect(emitted).toEqual(["@re-infra is online.", "@re-infra is offline."]);
  });

  it("does not flap when a session reconnects within the grace window", () => {
    const { live, emitted, sched, tracker } = harness();
    live.add("re-infra");
    tracker.onConnect("re-infra");

    live.delete("re-infra");
    tracker.onDetach("re-infra"); // schedule offline
    live.add("re-infra");
    tracker.onConnect("re-infra"); // reconnect within grace — cancels it

    expect(sched.size).toBe(0);
    sched.flush();
    expect(emitted).toEqual(["@re-infra is online."]); // no offline, no second online
  });

  it("never schedules offline for a displaced session (a newer one is live)", () => {
    const { live, emitted, sched, tracker } = harness();
    live.add("re-infra");
    tracker.onConnect("re-infra");
    tracker.onConnect("re-infra"); // restart: new session displaces the old

    // the old session detaches, but the registry still holds the newer one
    tracker.onDetach("re-infra");
    expect(sched.size).toBe(0);
    sched.flush();
    expect(emitted).toEqual(["@re-infra is online."]);
  });

  it("stays online if a reconnect races the grace timer (isLive at fire time)", () => {
    const { live, emitted, sched, tracker } = harness();
    live.add("re-infra");
    tracker.onConnect("re-infra");

    live.delete("re-infra");
    tracker.onDetach("re-infra"); // schedule offline
    live.add("re-infra"); // registry live again before the timer fires (no onConnect yet)

    sched.flush(); // timer re-checks isLive → still live → no offline
    expect(emitted).toEqual(["@re-infra is online."]);
  });

  it("tracks agents independently", () => {
    const { live, emitted, sched, tracker } = harness();
    live.add("a");
    tracker.onConnect("a");
    live.add("b");
    tracker.onConnect("b");
    live.delete("a");
    tracker.onDetach("a");
    sched.flush();
    expect(emitted).toEqual(["@a is online.", "@b is online.", "@a is offline."]);
  });

  it("cancels pending offline timers on stop()", () => {
    const { live, emitted, sched, tracker } = harness();
    live.add("a");
    tracker.onConnect("a");
    live.delete("a");
    tracker.onDetach("a");
    tracker.stop();
    sched.flush();
    expect(emitted).toEqual(["@a is online."]); // stop() cancelled the offline
  });
});
