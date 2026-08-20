import { describe, it, expect, afterEach } from "vitest";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundFrame } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter, type Scheduler } from "../src/index.js";
import { waitFor, delay } from "./helpers.js";

/** A scheduler the test drives explicitly, so time advances deterministically. */
class FakeScheduler {
  private pending = new Map<number, () => void>();
  private nextId = 0;
  readonly schedule: Scheduler = (fn) => {
    const id = this.nextId++;
    this.pending.set(id, fn);
    return () => this.pending.delete(id);
  };
  /** Fire every pending timer (timers armed during the flush survive to the next). */
  flush(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }
}

function hubConfig() {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "user1",
    HUB_ROOMS: "-100",
    HUB_BIND_HOST: "127.0.0.1",
    HUB_BIND_PORT: "0",
    HUB_ADAPTER: "loopback",
    HUB_SLA: "on",
    HUB_LOG_LEVEL: "error",
  });
}

function channelConfig(url: string, agent: string): ChannelConfig {
  return {
    hubUrl: url,
    sessionSecret: "s3cr3t",
    agent,
    logLevel: "error",
    reconnectInitialMs: 30,
    reconnectMaxMs: 120,
    maxFileMb: 50,
  };
}

let hub: Hub | undefined;
const clients: HubClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  if (hub) await hub.stop();
  hub = undefined;
});

async function startHub(): Promise<{ adapter: LoopbackAdapter; url: string; sched: FakeScheduler }> {
  const adapter = new LoopbackAdapter();
  const sched = new FakeScheduler();
  hub = new Hub({ config: hubConfig(), adapter, logger: () => {}, scheduler: sched.schedule });
  await hub.start();
  return { adapter, url: `ws://127.0.0.1:${hub.port()}`, sched };
}

function attach(url: string, agent: string) {
  const injected: InboundFrame[] = [];
  let registered = false;
  const client = new HubClient(channelConfig(url, agent), {
    onInbound: (f) => injected.push(f),
    onRegistered: () => {
      registered = true;
    },
  });
  clients.push(client);
  client.start();
  return { client, injected, registered: () => registered };
}

describe("response SLA (durable backstop)", () => {
  it("nudges the silent peer at T1 and escalates to the operator at T2", async () => {
    const { adapter, url, sched } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    // re-infra asks re-gitops; the hop is delivered → the SLA starts watching
    infra.client.sendReply({ room: "-100", text: "need the egress IP", mentions: ["re-gitops"] });
    await waitFor(() => gitops.injected.length >= 1);

    // T1: the peer is still silent → a single nudge is re-injected into its session
    sched.flush();
    await waitFor(() => gitops.injected.length >= 2);
    expect(gitops.injected[1].message.text).toContain("still waiting");
    expect(gitops.injected[1].message.mentions).toContain("re-gitops");

    // T2: still silent → the operator is escalated in the room…
    sched.flush();
    const escalation = await adapter.waitForSent((s) => s.out.text.includes("unanswered"));
    expect(escalation.out).toMatchObject({ agent: "hub", kind: "notice" });
    expect(escalation.out.text).toContain("@re-infra");
    expect(escalation.out.text).toContain("@re-gitops");
    expect(escalation.target.room).toBe("-100");

    // …and the asker is unblocked in its session
    await waitFor(() => infra.injected.length >= 1);
    expect(infra.injected[0].message.text).toContain("no response from @re-gitops");
  });

  it("a peer ack cancels the nudge and the escalation", async () => {
    const { adapter, url, sched } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    infra.client.sendReply({ room: "-100", text: "need the egress IP", mentions: ["re-gitops"] });
    await waitFor(() => gitops.injected.length >= 1);

    // the peer acks (Part B2) — any reply from it satisfies the ask
    gitops.client.sendReply({ room: "-100", text: "on it, ~15m" });
    await adapter.waitForSent((s) => s.out.text.includes("on it"));

    sched.flush(); // would-be T1
    sched.flush(); // would-be T2
    await delay(30);
    expect(gitops.injected).toHaveLength(1); // no nudge — only the original hop
    expect(adapter.sent.some((s) => s.out.text.includes("unanswered"))).toBe(false);
  });

  it("does not arm an ack-of-the-ack watch when a reply answers the peer it tags (#100)", async () => {
    const { adapter, url, sched } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    // gitops asks infra → watch gitops→infra
    gitops.client.sendReply({ room: "-100", text: "what's the egress IP?", mentions: ["re-infra"] });
    await waitFor(() => infra.injected.length >= 1);

    // infra answers AND tags gitops back (so gitops sees the answer). This closes
    // gitops→infra; it must NOT arm a fresh infra→gitops watch (the ping-pong).
    infra.client.sendReply({ room: "-100", text: "1.2.3.4 — all set?", mentions: ["re-gitops"] });
    await waitFor(() => gitops.injected.length >= 1);

    sched.flush(); // would-be T1
    sched.flush(); // would-be T2
    await delay(30);
    // no "still waiting" nag to gitops, no escalation — the loop is broken
    expect(gitops.injected.every((f) => !f.message.text.includes("still waiting"))).toBe(true);
    expect(adapter.sent.some((s) => s.out.text.includes("unanswered"))).toBe(false);
  });

  it("no_reply suppresses the response watch for a tagged FYI/ack (#100)", async () => {
    const { adapter, url, sched } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    // infra tags gitops on a status/FYI it doesn't expect a reply to
    infra.client.sendReply({
      room: "-100",
      text: "FYI PR #123 is up, no action needed",
      mentions: ["re-gitops"],
      noReply: true,
    });
    await waitFor(() => gitops.injected.length >= 1); // gitops still SEES it

    sched.flush(); // would-be T1
    sched.flush(); // would-be T2
    await delay(30);
    expect(gitops.injected.every((f) => !f.message.text.includes("still waiting"))).toBe(true);
    expect(adapter.sent.some((s) => s.out.text.includes("unanswered"))).toBe(false);
  });

  it("still escalates after the asker's session has gone (durable net)", async () => {
    const { adapter, url, sched } = await startHub();
    const infra = attach(url, "re-infra");
    const gitops = attach(url, "re-gitops");
    await waitFor(() => infra.registered() && gitops.registered());

    infra.client.sendReply({ room: "-100", text: "need the egress IP", mentions: ["re-gitops"] });
    await waitFor(() => gitops.injected.length >= 1);

    infra.client.stop(); // the asker's session dies, taking its own follow-up timer with it
    await delay(20);

    sched.flush(); // T1 nudge to the (still-online) peer
    await waitFor(() => gitops.injected.length >= 2);
    sched.flush(); // T2 escalation survives the asker being gone
    const escalation = await adapter.waitForSent((s) => s.out.text.includes("unanswered"));
    expect(escalation.out.text).toContain("@re-infra");
  });
});
