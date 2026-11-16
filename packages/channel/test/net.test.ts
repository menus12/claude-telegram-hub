import { describe, it, expect } from "vitest";
import { connectPlan, noProxyMatches, proxyFor, redactProxy, upgradeFailureHint } from "../src/net.js";

const u = (s: string) => new URL(s);

describe("proxyFor (#125)", () => {
  const env = { HTTPS_PROXY: "http://proxy.corp:3128", HTTP_PROXY: "http://plain.corp:8080" };

  it("uses HTTPS_PROXY for wss and HTTP_PROXY for ws", () => {
    expect(proxyFor(u("wss://hub.example"), env)?.host).toBe("proxy.corp:3128");
    expect(proxyFor(u("ws://hub.example:8787"), env)?.host).toBe("plain.corp:8080");
  });

  it("never proxies loopback, honors NO_PROXY, and lets config override env", () => {
    expect(proxyFor(u("ws://127.0.0.1:8788"), env)).toBeUndefined();
    expect(proxyFor(u("wss://localhost"), env)).toBeUndefined();
    expect(proxyFor(u("wss://hub.example"), { ...env, NO_PROXY: "corp.local,.example" })).toBeUndefined();
    expect(proxyFor(u("wss://hub.example"), env, "off")).toBeUndefined();
    expect(proxyFor(u("wss://hub.example"), {}, "http://explicit:1")?.host).toBe("explicit:1");
  });
});

describe("noProxyMatches (#125)", () => {
  it("matches curl-style entries", () => {
    expect(noProxyMatches(u("wss://a.nsalab.org"), "nsalab.org")).toBe(true);
    expect(noProxyMatches(u("wss://a.nsalab.org"), "*.nsalab.org")).toBe(true);
    expect(noProxyMatches(u("wss://nsalab.org.evil"), "nsalab.org")).toBe(false);
    expect(noProxyMatches(u("wss://a.b"), "*")).toBe(true);
    expect(noProxyMatches(u("wss://a.b"), "a.b:8443")).toBe(false);
    expect(noProxyMatches(u("wss://a.b"), "a.b:443")).toBe(true);
  });
});

describe("connectPlan (#125)", () => {
  it("redacts proxy credentials and passes headers through", () => {
    const plan = connectPlan("wss://hub.example", {
      headers: { X: "1" },
      env: { HTTPS_PROXY: "http://user:pw@proxy.corp:3128" },
    });
    expect(plan.proxy).toBe("http://proxy.corp:3128");
    expect(plan.options.headers).toEqual({ X: "1" });
    expect(plan.options.agent).toBeDefined();
    expect(redactProxy(u("http://user:pw@p:1"))).not.toContain("pw");
  });

  it("adds no CA list for plain ws or when systemCa is off", () => {
    expect(connectPlan("ws://127.0.0.1:8788", { env: {} }).options.ca).toBeUndefined();
    expect(connectPlan("wss://hub.example", { env: {}, systemCa: false }).systemCa).toBe(false);
  });
});

describe("upgradeFailureHint (#125)", () => {
  it("names a stripped upgrade behind an inspecting proxy", () => {
    expect(upgradeFailureHint(404, { "cache-status": "corp;detail=no-cache" })).toMatch(/stripped in transit/);
  });
  it("names Cloudflare Access and proxy auth", () => {
    expect(upgradeFailureHint(403, { server: "cloudflare", "cf-access-domain": "h" })).toMatch(/Cloudflare Access/);
    expect(upgradeFailureHint(407, {})).toMatch(/proxy requires authentication/);
  });
});
