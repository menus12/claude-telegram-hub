import { describe, it, expect } from "vitest";
import type WebSocket from "ws";
import { AgentRegistry, Session } from "../src/index.js";

function fakeSession(agent: string): Session {
  const ws = { readyState: 1, send() {}, close() {} } as unknown as WebSocket;
  return new Session(agent, ws);
}

describe("AgentRegistry", () => {
  it("registers and looks up by agent name", () => {
    const registry = new AgentRegistry();
    const session = fakeSession("re-infra");
    expect(registry.register(session)).toBeUndefined();
    expect(registry.has("re-infra")).toBe(true);
    expect(registry.get("re-infra")).toBe(session);
    expect(registry.list()).toEqual(["re-infra"]);
  });

  it("returns the displaced session when an agent re-registers (restart)", () => {
    const registry = new AgentRegistry();
    const first = fakeSession("a");
    const second = fakeSession("a");
    registry.register(first);
    expect(registry.register(second)).toBe(first);
    expect(registry.get("a")).toBe(second);
  });

  it("unregister only removes the current session, not a displaced one", () => {
    const registry = new AgentRegistry();
    const first = fakeSession("a");
    const second = fakeSession("a");
    registry.register(first);
    registry.register(second);
    // a late close() from the displaced `first` must not evict `second`
    registry.unregister(first);
    expect(registry.get("a")).toBe(second);
    registry.unregister(second);
    expect(registry.has("a")).toBe(false);
  });
});
