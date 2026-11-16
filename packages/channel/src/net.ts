import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { ClientOptions } from "ws";

/**
 * Network plumbing for the hub link on restricted networks (#125):
 *   - an HTTP(S) proxy (`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, or the config's
 *     `proxy`), tunnelled with `CONNECT` — `ws` ignores proxy env vars by itself;
 *   - the OS certificate store (a TLS-inspecting proxy re-signs with an enterprise
 *     CA that lives there, not in Node's bundled list).
 * Built on Node's own http/tls so the bundled plugin gains no dependency.
 */

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith("127.");
}

function defaultPort(url: URL): string {
  return url.port || (url.protocol === "wss:" || url.protocol === "https:" ? "443" : "80");
}

/**
 * `NO_PROXY` match, curl-style: `*` = everything; `host`, `.host` or `*.host` match
 * the host and its subdomains; an entry with `:port` must match the port too.
 */
export function noProxyMatches(target: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = target.hostname.toLowerCase();
  const port = defaultPort(target);
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const [name, entryPort] = entry.split(/:(?=\d+$)/);
    if (entryPort && entryPort !== port) continue;
    const bare = name.replace(/^\*?\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * The proxy to use for `target`, or undefined for a direct connection. An explicit
 * config value wins (`"off"`/`"none"` forces direct); otherwise the scheme's env var.
 * Loopback targets never go through a proxy.
 */
export function proxyFor(target: URL, env: Env, configured?: string): URL | undefined {
  if (isLoopback(target.hostname)) return undefined;
  if (configured !== undefined && configured !== "") {
    if (/^(off|none|direct)$/i.test(configured)) return undefined;
    return new URL(configured);
  }
  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const value = secure
    ? (env.HTTPS_PROXY ?? env.https_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy);
  if (!value) return undefined;
  if (noProxyMatches(target, env.NO_PROXY ?? env.no_proxy)) return undefined;
  return new URL(value);
}

/** A proxy URL safe to log (credentials stripped). */
export function redactProxy(proxy: URL): string {
  return `${proxy.protocol}//${proxy.host}`;
}

type ConnectCallback = (err: Error | null, socket?: Duplex) => void;

/** Open a `CONNECT host:port` tunnel through `proxy`. */
function openTunnel(proxy: URL, host: string, port: number, cb: (err: Error | null, socket?: Duplex) => void): void {
  const auth =
    proxy.username || proxy.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
      : undefined;
  const mod = proxy.protocol === "https:" ? https : http;
  const req = mod.request({
    host: proxy.hostname,
    port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
    method: "CONNECT",
    path: `${host}:${port}`,
    headers: { host: `${host}:${port}`, ...(auth ? { "proxy-authorization": auth } : {}) },
    agent: false,
  });
  req.once("connect", (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      cb(new Error(`proxy CONNECT to ${host}:${port} failed: ${res.statusCode} ${res.statusMessage ?? ""}`.trim()));
      return;
    }
    cb(null, socket);
  });
  req.once("error", (err) => cb(err));
  req.end();
}

interface TunnelConnectOptions {
  host?: string | null;
  hostname?: string | null;
  port?: number | string | null;
  servername?: string;
}

/** An agent whose sockets are `CONNECT` tunnels through `proxy` (TLS on top for wss). */
export function tunnelAgent(target: URL, proxy: URL): http.Agent {
  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const create = (options: TunnelConnectOptions & tls.ConnectionOptions, cb: ConnectCallback): undefined => {
    const host = options.hostname ?? options.host ?? target.hostname;
    const port = Number(options.port ?? defaultPort(target));
    openTunnel(proxy, host, port, (err, socket) => {
      if (err || !socket) return cb(err ?? new Error("proxy tunnel failed"));
      if (!secure) return cb(null, socket);
      const tlsSocket = tls.connect({ ...options, socket, servername: options.servername ?? host });
      tlsSocket.once("secureConnect", () => cb(null, tlsSocket));
      tlsSocket.once("error", (e) => cb(e));
    });
    return undefined;
  };
  // Node's Agent accepts an async createConnection(options, callback).
  const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  (agent as unknown as { createConnection: typeof create }).createConnection = create;
  return agent;
}

/**
 * CAs to trust for the hub link: Node's defaults plus the OS store, so a corporate
 * TLS-inspection CA is honored (Node ≥ 22.15 / 23.5 expose `tls.getCACertificates`).
 * Undefined = leave Node's default behavior (older Node, or `systemCa: false`).
 */
export function trustedCas(systemCa: boolean): string[] | undefined {
  if (!systemCa) return undefined;
  const get = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (typeof get !== "function") return undefined;
  try {
    return [...new Set([...get("default"), ...get("system")])];
  } catch {
    return undefined;
  }
}

export interface ConnectPlan {
  options: ClientOptions;
  /** Proxy in use (redacted), for the startup log. */
  proxy?: string;
  /** Whether the OS certificate store is trusted in addition to Node's defaults. */
  systemCa: boolean;
}

/** Everything `ws` needs to reach `hubUrl` on this network: headers, proxy, CAs. */
export function connectPlan(
  hubUrl: string,
  opts: { headers?: Record<string, string>; proxy?: string; systemCa?: boolean; env?: Env },
): ConnectPlan {
  const target = new URL(hubUrl);
  const proxy = proxyFor(target, opts.env ?? process.env, opts.proxy);
  const secure = target.protocol === "wss:";
  const ca = secure ? trustedCas(opts.systemCa ?? true) : undefined;
  return {
    options: {
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(proxy ? { agent: tunnelAgent(target, proxy) } : {}),
      ...(ca ? { ca } : {}),
    },
    ...(proxy ? { proxy: redactProxy(proxy) } : {}),
    systemCa: ca !== undefined,
  };
}

/**
 * Explain a non-101 answer to the WebSocket upgrade — the usual corporate-network
 * failure modes, each with what to do (#125).
 */
export function upgradeFailureHint(status: number, headers: http.IncomingHttpHeaders): string {
  const viaProxy = headers.via !== undefined || headers["cache-status"] !== undefined;
  if (status === 407) return "the HTTP proxy requires authentication — put credentials in the proxy URL";
  if (status === 401 || status === 403) {
    return headers["cf-access-domain"] !== undefined || String(headers.server ?? "").includes("cloudflare")
      ? "blocked by Cloudflare Access — check the connect headers (CF-Access-Client-Id/Secret)"
      : "rejected before reaching the hub — check the connect headers";
  }
  if (status === 404 || status === 200 || status === 400 || status === 426) {
    return viaProxy
      ? "the WebSocket upgrade was stripped in transit (an inspecting proxy turned it into a plain GET) — ask IT to exempt the hub host from TLS inspection"
      : "the server answered without upgrading — is the URL the hub's WebSocket endpoint?";
  }
  return "unexpected answer to the WebSocket upgrade";
}
