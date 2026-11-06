/**
 * HTTPS_PROXY, HTTP_PROXY and NO_PROXY for every request olcli makes.
 *
 * The client talks to Overleaf through node:http and node:https (see
 * httpRequest in client.ts), and the collaboration socket is Socket.IO
 * xhr-polling over the same function, so routing that one function through
 * the proxy covers all traffic. Node's own env-proxy support only exists in
 * recent releases and has to be switched on with NODE_USE_ENV_PROXY, and
 * undici's EnvHttpProxyAgent only serves fetch(), so this is done here with
 * no dependency:
 *
 * - an https:// target goes through a CONNECT tunnel, then TLS end to end,
 *   so the proxy never sees the cookie;
 * - an http:// target (self-hosted instances) is sent to the proxy with the
 *   absolute URL as the request target, as HTTP/1.1 proxies expect.
 *
 * Lower-case variable names win over upper-case ones, as in curl.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  return value && value.trim() ? value.trim() : undefined;
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * True when NO_PROXY exempts `target`. Entries are comma or space separated:
 * `*` matches everything, `example.com` and `.example.com` match the host and
 * its subdomains, `host:port` matches only that port, and an IP matches
 * itself. As in curl, loopback is not exempt unless NO_PROXY says so.
 */
export function bypassesProxy(target: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  const noProxy = envValue(env, 'no_proxy');
  if (!noProxy) return false;
  const port = Number(target.port || defaultPort(target.protocol));

  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;

    let entryPort: number | undefined;
    const portMatch = entry.match(/^(.*):(\d+)$/);
    if (portMatch && !portMatch[1].includes(':')) {
      entry = portMatch[1];
      entryPort = Number(portMatch[2]);
    }
    entry = entry.replace(/^\[|\]$/g, '').replace(/^\*?\./, '');
    if (entryPort !== undefined && entryPort !== port) continue;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** The proxy for `target`, or undefined when it should be reached directly. */
export function proxyForUrl(target: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const raw = target.protocol === 'https:'
    ? envValue(env, 'https_proxy') ?? envValue(env, 'all_proxy')
    : envValue(env, 'http_proxy') ?? envValue(env, 'all_proxy');
  if (!raw || bypassesProxy(target, env)) return undefined;
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    throw new Error(`Invalid proxy URL in the environment: ${raw}`);
  }
}

function proxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

type ConnectionCallback = (error: Error | null, socket?: Duplex) => void;

/**
 * An https.Agent whose sockets are CONNECT tunnels through `proxy`. Node's
 * Agent accepts an asynchronous createConnection that reports through the
 * callback, which is what lets the tunnel be opened before TLS starts.
 */
class TunnelAgent extends https.Agent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: false });
  }

  createConnection(options: https.RequestOptions & tls.ConnectionOptions, callback: ConnectionCallback): undefined {
    const host = String(options.host ?? options.hostname ?? 'localhost');
    const port = Number(options.port ?? 443);
    const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
    const transport = this.proxy.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { Host: authority };
    const auth = proxyAuthorization(this.proxy);
    if (auth) headers['Proxy-Authorization'] = auth;

    const connect = transport.request({
      host: this.proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(this.proxy.port || defaultPort(this.proxy.protocol)),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
    });

    connect.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(Object.assign(
          new Error(`Proxy ${this.proxy.host} refused CONNECT ${authority}: HTTP ${res.statusCode}`),
          { code: 'EPROXY' },
        ));
        return;
      }
      const secure = tls.connect({
        socket,
        servername: options.servername || (isIP(host) ? undefined : host),
        rejectUnauthorized: options.rejectUnauthorized,
        ca: options.ca,
      });
      secure.once('secureConnect', () => callback(null, secure));
      secure.once('error', (error) => callback(error));
    });
    connect.once('error', (error) => callback(error));
    connect.end();
    return undefined;
  }
}

const tunnelAgents = new Map<string, TunnelAgent>();

export interface ProxiedRequest {
  /** What to pass to http(s).request as the URL. */
  url: string;
  /** Extra request options (agent, headers) for the proxy. */
  options: http.RequestOptions;
  /** The transport module to call request() on. */
  transport: typeof http | typeof https;
  /** The proxy in use, for --verbose; undefined for a direct request. */
  proxy?: URL;
}

/**
 * How to send a request to `reqUrl`, honoring the proxy variables in `env`.
 * The headers passed in are extended, never replaced.
 */
export function routeRequest(
  reqUrl: string,
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): ProxiedRequest {
  const target = new URL(reqUrl);
  const direct = target.protocol === 'https:' ? https : http;
  const proxy = proxyForUrl(target, env);
  if (!proxy) return { url: reqUrl, options: { headers }, transport: direct };

  if (target.protocol === 'https:') {
    let agent = tunnelAgents.get(proxy.href);
    if (!agent) {
      agent = new TunnelAgent(proxy);
      tunnelAgents.set(proxy.href, agent);
    }
    return { url: reqUrl, options: { headers, agent }, transport: https, proxy };
  }

  // Plain HTTP: ask the proxy for the absolute URL.
  const auth = proxyAuthorization(proxy);
  return {
    url: `${proxy.protocol}//${proxy.host}${proxy.pathname === '/' ? '' : proxy.pathname}`,
    options: {
      headers: { ...headers, Host: target.host, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
      path: target.href,
      agent: false,
    },
    transport: proxy.protocol === 'https:' ? https : http,
    proxy,
  };
}
