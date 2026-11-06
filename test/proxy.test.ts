import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bypassesProxy, isLoopbackHost, proxyForUrl } from '../src/proxy.js';
import { OverleafClient } from '../src/client.js';

// The proxy variables are read per request from process.env, so each test
// sets them and restores the previous values afterwards.
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return await run();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('proxyForUrl picks the variable for the scheme, lower case first', () => {
  const env = { HTTPS_PROXY: 'http://upper:1', https_proxy: 'http://lower:2', HTTP_PROXY: 'plain:3' };
  assert.equal(proxyForUrl(new URL('https://www.overleaf.com/project'), env)?.host, 'lower:2');
  assert.equal(proxyForUrl(new URL('http://overleaf.example/project'), env)?.href, 'http://plain:3/');
  assert.equal(proxyForUrl(new URL('https://www.overleaf.com/'), {}), undefined);
});

test('NO_PROXY matches hosts, subdomains, ports and *', () => {
  const env = { NO_PROXY: 'internal.example, .corp.example,10.0.0.5,ol.example:8443' };
  assert.equal(bypassesProxy(new URL('https://internal.example/'), env), true);
  assert.equal(bypassesProxy(new URL('https://a.internal.example/'), env), true);
  assert.equal(bypassesProxy(new URL('https://x.corp.example/'), env), true);
  assert.equal(bypassesProxy(new URL('http://10.0.0.5/'), env), true);
  assert.equal(bypassesProxy(new URL('https://ol.example:8443/'), env), true);
  assert.equal(bypassesProxy(new URL('https://ol.example/'), env), false);
  assert.equal(bypassesProxy(new URL('https://www.overleaf.com/'), env), false);
  assert.equal(bypassesProxy(new URL('https://www.overleaf.com/'), { no_proxy: '*' }), true);
});

test('HTTP_PROXY carries plain-HTTP requests, with the absolute URL as target', async () => {
  const seen: string[] = [];
  const proxy = await listen((req, res) => {
    seen.push(`${req.method} ${req.url} host=${req.headers.host} auth=${req.headers['proxy-authorization'] ?? '-'}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  try {
    await withEnv({ HTTP_PROXY: `http://user:pa%20ss@127.0.0.1:${proxy.port}` }, async () => {
      const client = new OverleafClient({ cookies: {}, csrf: 'x', baseUrl: 'http://overleaf.invalid' });
      await client.getEntities('0123456789abcdef01234567').catch(() => undefined);
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^GET http:\/\/overleaf\.invalid\/project\/0123456789abcdef01234567\/entities host=overleaf\.invalid /);
    assert.match(seen[0], new RegExp(`auth=Basic ${Buffer.from('user:pa ss').toString('base64')}`));
  } finally {
    await proxy.close();
  }
});

test('HTTPS_PROXY opens a CONNECT tunnel to the target and reports a refusal', async () => {
  const seen: string[] = [];
  const proxy = await listen(() => undefined);
  proxy.server.on('connect', (req, socket) => {
    seen.push(`${req.method} ${req.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  try {
    await withEnv({ HTTPS_PROXY: `127.0.0.1:${proxy.port}` }, async () => {
      const client = new OverleafClient({ cookies: {}, csrf: 'x', baseUrl: 'https://www.overleaf.com' });
      await assert.rejects(client.getEntities('0123456789abcdef01234567'), /refused CONNECT www\.overleaf\.com:443: HTTP 403/);
    });
    assert.deepEqual(seen, ['CONNECT www.overleaf.com:443']);
  } finally {
    await proxy.close();
  }
});

test('NO_PROXY sends the request directly', async () => {
  let proxied = 0;
  const proxy = await listen((_req, res) => { proxied++; res.end(); });
  const target = await listen((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"entities":[]}');
  });
  try {
    await withEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '127.0.0.1' }, async () => {
      const client = new OverleafClient({ cookies: {}, csrf: 'x', baseUrl: `http://127.0.0.1:${target.port}` });
      await client.getEntities('0123456789abcdef01234567');
    });
    assert.equal(proxied, 0);
  } finally {
    await proxy.close();
    await target.close();
  }
});


test('the root help documents the proxy variables', async () => {
  const { spawnSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, '--help'], { encoding: 'utf-8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) assert.match(result.stdout, new RegExp(name));
});

test('loopback is always direct, whatever NO_PROXY says', () => {
  const env = { HTTPS_PROXY: 'http://proxy.example:3128', HTTP_PROXY: 'http://proxy.example:3128', ALL_PROXY: 'http://proxy.example:3128', NO_PROXY: 'other.example' };
  for (const url of [
    'http://localhost:9222/json/version',
    'https://LOCALHOST/',
    'http://app.localhost/',
    'http://127.0.0.1:8080/',
    'http://127.1.2.3/',
    'http://[::1]:9222/',
    'https://[0:0:0:0:0:0:0:1]/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.equal(proxyForUrl(new URL(url), env), undefined, url);
    assert.equal(proxyForUrl(new URL(url), { ALL_PROXY: 'http://proxy.example:3128' }), undefined, url);
  }
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('::1'), true);
  for (const host of ['128.0.0.1', '10.0.0.1', 'localhost.example', 'mylocalhost', '::2', 'www.overleaf.com']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
  assert.equal(proxyForUrl(new URL('http://128.0.0.1/'), env)?.host, 'proxy.example:3128');
  assert.equal(proxyForUrl(new URL('https://localhost.example/'), env)?.host, 'proxy.example:3128');
});

test('a localhost request never touches the proxy, even with an empty NO_PROXY', async () => {
  let proxied = 0;
  const proxy = await listen((_req, res) => { proxied++; res.end(); });
  const target = await listen((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"entities":[]}');
  });
  try {
    await withEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, ALL_PROXY: `http://127.0.0.1:${proxy.port}` }, async () => {
      const client = new OverleafClient({ cookies: {}, csrf: 'x', baseUrl: `http://localhost:${target.port}` });
      await client.getEntities('0123456789abcdef01234567');
    });
    assert.equal(proxied, 0);
  } finally {
    await proxy.close();
    await target.close();
  }
});
