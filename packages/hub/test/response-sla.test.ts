import { describe, it, expect } from "vitest";
import { ResponseSla, type PendingAsk } from "../src/response-sla.js";
import type { Scheduler } from "../src/scheduler.js";

/** A controllable scheduler: nothing fires until `flush()` (a window elapsed). */
class FakeScheduler {
  private pending = new Map<number, () => void>();
  private nextId = 0;

  readonly schedule: Scheduler = (fn) => {
    const id = this.nextId++;
    this.pending.set(id, fn);
    return () => this.pending.delete(id);
  };

  /** Fire every currently-pending timer (timers armed during the flush survive). */
  flush(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }

  get size(): number {
    return this.pending.size;
  }
}

function harness() {
  const nudged: PendingAsk[] = [];
  const escalated: PendingAsk[] = [];
  const sched = new FakeScheduler();
  const sla = new ResponseSla({
    ackSlaMs: 100,
    answerSlaMs: 300,
    nudge: (a) => nudged.push(a),
    escalate: (a) => escalated.push(a),
    schedule: sched.schedule,
  });
  return { nudged, escalated, sched, sla };
}

const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  room: "-100",
  from: "re-infra",
  to: "re-gitops",
  text: "need the egress IP",
  ...over,
});

describe("ResponseSla", () => {
  it("nudges the peer once when it stays silent past T1", () => {
    const { nudged, escalated, sched, sla } = harness();
    sla.openAsk(ask());
    expect(nudged).toHaveLength(0);
    sched.flush(); // T1
    expect(nudged).toEqual([ask()]);
    expect(escalated).toHaveLength(0);
  });

  it("escalates after T2 when silence continues past the nudge", () => {
    const { nudged, escalated, sched, sla } = harness();
    sla.openAsk(ask());
    sched.flush(); // T1 → nudge, arms T2
    sched.flush(); // T2 → escalate
    expect(nudged).toHaveLength(1);
    expect(escalated).toEqual([ask()]);
    expect(sla.size).toBe(0); // watch cleared after escalation
  });

  it("a response before T1 cancels both the nudge and the escalation", () => {
    const { nudged, escalated, sched, sla } = harness();
    sla.openAsk(ask());
    sla.onAgentSpoke("-100", "re-gitops"); // the peer replied
    expect(sla.size).toBe(0);
    sched.flush();
    sched.flush();
    expect(nudged).toHaveLength(0);
    expect(escalated).toHaveLength(0);
  });

  it("a response between T1 and T2 cancels the escalation (nudge already sent)", () => {
    const { nudged, escalated, sched, sla } = harness();
    sla.openAsk(ask());
    sched.flush(); // T1 → nudge
    sla.onAgentSpoke("-100", "re-gitops");
    sched.flush(); // T2 window — but cancelled
    expect(nudged).toHaveLength(1);
    expect(escalated).toHaveLength(0);
  });

  it("only satisfies asks waiting on the speaker, in the speaker's room", () => {
    const { nudged, sched, sla } = harness();
    sla.openAsk(ask({ from: "a", to: "b" })); // a→b in -100
    sla.openAsk(ask({ from: "c", to: "b" })); // c→b in -100
    sla.openAsk(ask({ from: "a", to: "d" })); // a→d in -100
    sla.openAsk(ask({ room: "-200", from: "a", to: "b" })); // a→b in a different room
    expect(sla.size).toBe(4);

    sla.onAgentSpoke("-100", "b"); // b spoke in -100
    expect(sla.size).toBe(2); // a→d and the -200 a→b remain

    sched.flush(); // T1 for the two survivors
    expect(nudged.map((n) => `${n.room}:${n.from}->${n.to}`).sort()).toEqual([
      "-100:a->d",
      "-200:a->b",
    ]);
  });

  it("re-asking restarts the clock rather than double-arming", () => {
    const { nudged, sched, sla } = harness();
    sla.openAsk(ask());
    sla.openAsk(ask()); // same (room,from,to) — refreshes
    expect(sla.size).toBe(1);
    sched.flush();
    expect(nudged).toHaveLength(1); // the first timer was cancelled, not fired
  });

  it("treats from→to and to→from as distinct asks", () => {
    const { sla } = harness();
    sla.openAsk(ask({ from: "a", to: "b" }));
    sla.openAsk(ask({ from: "b", to: "a" }));
    expect(sla.size).toBe(2);
    sla.onAgentSpoke("-100", "b"); // satisfies a→b only
    expect(sla.size).toBe(1);
  });

  it("stop() cancels all pending timers", () => {
    const { nudged, escalated, sched, sla } = harness();
    sla.openAsk(ask());
    sla.stop();
    expect(sla.size).toBe(0);
    sched.flush();
    expect(nudged).toHaveLength(0);
    expect(escalated).toHaveLength(0);
  });
});
