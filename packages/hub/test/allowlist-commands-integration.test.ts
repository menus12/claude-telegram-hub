import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "@claude-telegram-hub/channel";
import { loadHubConfig } from "@claude-telegram-hub/protocol";
import type { ChannelConfig, InboundFrame, InboundMessage } from "@claude-telegram-hub/protocol";
import { Hub, LoopbackAdapter } from "../src/index.js";
import { waitFor, delay } from "./helpers.js";

function hubConfig(over: Record<string, string> = {}) {
  return loadHubConfig({
    HUB_SESSION_SECRET: "s3cr3t",
    HUB_ALLOWLIST: "admin1",
    HUB_BIND_HOST: "127.0.0.1",
    HUB_BIND_PORT: "0",
    HUB_ADAPTER: "loopback",
    HUB_LOG_LEVEL: "error",
    ...over,
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

function msg(fromId: string, text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: "loopback",
    room: fromId, // DM: the room is the sender's id
    fromKind: "human",
    fromId,
    text,
    mentions: [],
    ...over,
  };
}

let hub: Hub | undefined;
const clients: HubClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  if (hub) await hub.stop();
  hub = undefined;
});

async function startHub(over: Record<string, string> = {}): Promise<{
  adapter: LoopbackAdapter;
  url: string;
}> {
  const adapter = new LoopbackAdapter();
  hub = new Hub({ config: hubConfig(over), adapter, logger: () => {} });
  await hub.start();
  return { adapter, url: `ws://127.0.0.1:${hub.port()}` };
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
  return { injected, registered: () => registered };
}

const text = (adapter: LoopbackAdapter, pred: (t: string) => boolean) =>
  adapter.sent.find((s) => pred(s.out.text));

describe("in-chat allowlist commands", () => {
  it("an admin /allow grants access, and the granted user can reach an agent", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    await adapter.deliver(msg("admin1", "/allow 999"));
    await waitFor(() => text(adapter, (t) => t.includes("Allowed 999")) !== undefined);

    // the newly-allowed user is notified in their DM
    expect(adapter.sent.some((s) => s.target.room === "999")).toBe(true);

    // and can now route to an agent (previously they'd be dropped)
    await adapter.deliver(msg("999", "@re-infra hi", { mentions: ["re-infra"] }));
    await waitFor(() => infra.injected.length >= 1);
    expect(infra.injected[0].message.fromId).toBe("999");
  });

  it("ignores an admin command from a non-admin", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    await adapter.deliver(msg("outsider", "/allow 5"));
    await delay(30);
    expect(adapter.sent).toHaveLength(0); // no reply, no grant

    // 5 was not granted → still dropped
    await adapter.deliver(msg("5", "@re-infra hi", { mentions: ["re-infra"] }));
    await delay(30);
    expect(infra.injected).toHaveLength(0);
  });

  it("lists the allowlist for an admin", async () => {
    const { adapter } = await startHub();
    await adapter.deliver(msg("admin1", "/allowlist"));
    await waitFor(() => text(adapter, (t) => t.startsWith("Allowed:")) !== undefined);
    expect(text(adapter, (t) => t.startsWith("Allowed:"))!.out.text).toContain("admin1");
  });

  it("does not swallow a non-command slash message meant for an agent", async () => {
    const { adapter, url } = await startHub();
    const infra = attach(url, "re-infra");
    await waitFor(infra.registered);

    await adapter.deliver(msg("admin1", "/deploy the thing @re-infra", { mentions: ["re-infra"] }));
    await waitFor(() => infra.injected.length >= 1);
    expect(infra.injected[0].message.text).toContain("/deploy the thing");
  });

  it("pairing on: an unknown sender is queued and admins are notified", async () => {
    const { adapter } = await startHub({ HUB_PAIRING: "on" });
    await adapter.deliver(msg("stranger", "let me in"));
    await waitFor(() => adapter.sent.length >= 2);

    // stranger gets a pending reply; the admin is DM'd the request
    expect(text(adapter, (t) => t.includes("pending admin approval"))).toBeTruthy();
    const adminPing = adapter.sent.find((s) => s.target.room === "admin1");
    expect(adminPing?.out.text).toContain("/allow stranger");

    // the admin can then see it in /pending
    await adapter.deliver(msg("admin1", "/pending"));
    await waitFor(() => text(adapter, (t) => t.startsWith("Pending:")) !== undefined);
    expect(text(adapter, (t) => t.startsWith("Pending:"))!.out.text).toContain("stranger");
  });

  it("a granted user survives a hub restart (persisted state file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cth-state-"));
    try {
      const stateFile = join(dir, "access.json");

      // first hub instance: grant 999, then shut down
      const first = await startHub({ HUB_STATE_FILE: stateFile });
      await first.adapter.deliver(msg("admin1", "/allow 999"));
      await waitFor(() => text(first.adapter, (t) => t.includes("Allowed 999")) !== undefined);
      await hub!.stop();
      hub = undefined;

      // second hub instance from the same state file: 999 is still allowed
      const second = await startHub({ HUB_STATE_FILE: stateFile });
      const infra = attach(second.url, "re-infra");
      await waitFor(infra.registered);
      await second.adapter.deliver(msg("999", "@re-infra back", { mentions: ["re-infra"] }));
      await waitFor(() => infra.injected.length >= 1);
      expect(infra.injected[0].message.fromId).toBe("999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("in-chat config commands (/config, /set, /unset)", () => {
  it("lists settings, validates a set, and reverts on unset (admin)", async () => {
    const { adapter } = await startHub();

    await adapter.deliver(msg("admin1", "/config"));
    await waitFor(() => text(adapter, (t) => t.includes("Settings")) !== undefined);
    expect(text(adapter, (t) => t.includes("ttsmaxchars = 300"))).toBeDefined(); // env baseline

    await adapter.deliver(msg("admin1", "/set ttsmaxchars 400"));
    await waitFor(() => text(adapter, (t) => t.includes("ttsmaxchars = 400")) !== undefined);

    await adapter.deliver(msg("admin1", "/config"));
    await waitFor(
      () => text(adapter, (t) => t.includes("ttsmaxchars = 400") && t.includes("*")) !== undefined,
    );

    await adapter.deliver(msg("admin1", "/unset ttsmaxchars"));
    await waitFor(() => text(adapter, (t) => t.includes("reverted")) !== undefined);
  });

  it("rejects an invalid value, an unknown key, and a boot-only field", async () => {
    const { adapter } = await startHub();

    await adapter.deliver(msg("admin1", "/set ttsmaxchars nope"));
    await waitFor(() => text(adapter, (t) => t.includes("Invalid value")) !== undefined);

    await adapter.deliver(msg("admin1", "/set bogus on"));
    await waitFor(() => text(adapter, (t) => t.includes("Unknown or restart-only")) !== undefined);

    // a real config field that is boot-only isn't tunable
    await adapter.deliver(msg("admin1", "/set bindport 9999"));
    await waitFor(
      () =>
        adapter.sent.filter((s) => s.out.text.includes("Unknown or restart-only")).length >= 2,
    );
  });

  it("ignores /set from a non-admin", async () => {
    const { adapter } = await startHub();
    await adapter.deliver(msg("stranger", "/set ttsauto on"));
    await delay(20);
    expect(text(adapter, (t) => t.includes("ttsauto"))).toBeUndefined();
  });

  it("reconfigures a Tier-2 setting and keeps the SLA invariant (#80)", async () => {
    const { adapter } = await startHub({ HUB_ACK_SLA: "1000", HUB_ANSWER_SLA: "2000" });

    // a Tier-2 numeric is accepted and confirmed
    await adapter.deliver(msg("admin1", "/set hopbudget 5"));
    await waitFor(() => text(adapter, (t) => t.includes("hopbudget = 5")) !== undefined);

    // keepalive accepts 0 (disable)
    await adapter.deliver(msg("admin1", "/set keepalivems 0"));
    await waitFor(() => text(adapter, (t) => t.includes("keepalivems = 0")) !== undefined);

    // answerslams must stay greater than ackslams
    await adapter.deliver(msg("admin1", "/set answerslams 500"));
    await waitFor(() => text(adapter, (t) => t.includes("must be greater than ackslams")) !== undefined);
  });
});
