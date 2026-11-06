import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import {
  HttpStatusError,
  SessionExpiredError,
  SESSION_EXPIRED_HINT,
  formatError,
  httpError,
} from '../src/errors.js';
import { OverleafClient, isLoginRedirect } from '../src/client.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('401 and 403 become a session error whose message names the fix', () => {
  for (const status of [401, 403]) {
    const error = httpError('Failed to fetch projects', status);
    assert.ok(error instanceof SessionExpiredError);
    assert.equal(error.message, 'Session expired or invalid. Run: olcli auth');
    const lines = formatError(error);
    assert.equal(lines[0], SESSION_EXPIRED_HINT);
    assert.match(lines[1], new RegExp(`HTTP ${status}`));
    assert.match(lines[1], /--verbose/);
  }
});

test('other statuses keep the status after the cause, never instead of it', () => {
  const error = httpError('Failed to delete entity', 500);
  assert.ok(error instanceof HttpStatusError);
  const [first, second] = formatError(error);
  assert.match(first, /^Failed to delete entity: Overleaf answered with a server error/);
  assert.doesNotMatch(first, /500/);
  assert.match(second, /^HTTP 500\./);

  const notFound = formatError(httpError('Failed to get entities', 404));
  assert.match(notFound[0], /olcli list/);
  assert.match(formatError(httpError('Socket poll failed', 429))[0], /rate limiting/);
});

test('--verbose is not suggested when it is already on', () => {
  const lines = formatError(httpError('Failed to fetch projects', 403), { verbose: true });
  assert.doesNotMatch(lines.join('\n'), /--verbose/);
});

test('network failures and timeouts name the next step', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  assert.match(formatError(refused)[0], /Could not reach Overleaf \(ECONNREFUSED\)/);
  assert.match(formatError(new Error('Request timeout after 10ms'))[0], /--timeout/);
});

test('a redirect to /login is recognized, the password login itself is not', () => {
  assert.equal(isLoginRedirect('https://www.overleaf.com/project/x/download/zip', '/login'), true);
  assert.equal(isLoginRedirect('https://www.overleaf.com/project', 'https://www.overleaf.com/login?redir=%2Fproject'), true);
  assert.equal(isLoginRedirect('https://www.overleaf.com/login', '/project'), false);
  assert.equal(isLoginRedirect('https://www.overleaf.com/project', '/project/abc'), false);
});

test('a login redirect from any request rejects with the session hint', async () => {
  const server = createServer((req, res) => {
    res.writeHead(302, { Location: '/login' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    const client = new OverleafClient({ cookies: {}, csrf: 'x', baseUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(client.getEntities('0123456789abcdef01234567'), (error: unknown) => {
      assert.ok(error instanceof SessionExpiredError);
      assert.equal(error.status, 302);
      return true;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('no source file prints a bare "Failed: ${error.message}"', () => {
  const offenders: string[] = [];
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(join(SRC, name), 'utf-8');
    text.split('\n').forEach((line, index) => {
      if (/`Failed: \$\{/.test(line)) offenders.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the client embeds no raw "${response.status}" in an error message', () => {
  const text = readFileSync(join(SRC, 'client.ts'), 'utf-8');
  // `data.status` is the compile result ("failure", "timedout"), not HTTP.
  const raw = (text.match(/new Error\(`[^`]*\$\{(\w+)\.status\}/g) ?? []).filter((m) => !m.includes('${data.status}'));
  assert.deepEqual(raw, []);
});
