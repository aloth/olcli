import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as cheerio from 'cheerio';
import { OverleafClient } from '../src/client.js';
import { ProjectOwnerOnlyError, SessionExpiredError, formatError } from '../src/errors.js';
import { planProjectRenames } from '../src/rename-plan.js';

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

async function withStatus(status: number, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>Restricted - Overleaf</title></head></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a 403 on project rename names the owner rule, not an expired session (#62)', async () => {
  await withStatus(403, async (baseUrl) => {
    const client = new OverleafClient({ cookies: {}, csrf: 'c', baseUrl });
    await assert.rejects(client.renameProject('0123456789abcdef01234567', 'New'), (error: unknown) => {
      assert.ok(error instanceof ProjectOwnerOnlyError);
      assert.ok(!(error instanceof SessionExpiredError));
      const [first, second] = formatError(error);
      assert.equal(first, 'Only the project owner can rename a project.');
      assert.match(second, /HTTP 403/);
      assert.match(second, /olcli auth/);
      return true;
    });
  });
});

test('a 401 on project rename is still a session error', async () => {
  await withStatus(401, async (baseUrl) => {
    const client = new OverleafClient({ cookies: {}, csrf: 'c', baseUrl });
    await assert.rejects(client.renameProject('0123456789abcdef01234567', 'New'), SessionExpiredError);
  });
});

test('the owner check before the request names the owner and nothing else', () => {
  const error = new ProjectOwnerOnlyError('owner@example.org');
  assert.deepEqual(formatError(error), ['Only the project owner can rename a project. This project is owned by owner@example.org.']);
});

test('the signed-in user id is read from ol-user_id, then from ol-user', () => {
  assert.equal(OverleafClient.extractAccountUserId(cheerio.load(`<meta name="ol-user_id" content="${ME}">`)), ME);
  assert.equal(OverleafClient.extractAccountUserId(cheerio.load(`<meta name="ol-user" content='{"_id":"${ME}"}'>`)), ME);
  assert.equal(OverleafClient.extractAccountUserId(cheerio.load('<meta name="ol-user" content="not json">')), undefined);
});

test('foreignOwner flags only a definite mismatch', () => {
  const client = new OverleafClient({ cookies: {}, csrf: 'c' });
  const theirs = { owner: { id: OTHER, email: 'owner@example.org' } };
  assert.equal(client.foreignOwner(theirs), undefined, 'unknown account: do not block');
  client.accountUserId = ME;
  assert.equal(client.foreignOwner(theirs), 'owner@example.org');
  assert.equal(client.foreignOwner({ owner: { id: ME, email: 'me@example.org' } }), undefined);
  assert.equal(client.foreignOwner({}), undefined, 'no owner in the list: do not block');
});

test('rename-bulk skips projects owned by someone else and keeps the rest', () => {
  const projects = [
    { id: '1', name: 'Paper draft', owner: { id: ME, email: 'me@example.org' } },
    { id: '2', name: 'Shared draft', owner: { id: OTHER, email: 'owner@example.org' } },
    { id: '3', name: 'Old draft' },
  ];
  const plan = planProjectRenames(projects, { search: 'draft', replace: 'final', accountUserId: ME });
  assert.deepEqual(plan.planned.map((p) => p.id), ['1', '3']);
  assert.deepEqual(plan.skipped, [{ name: 'Shared draft', reason: 'owned by owner@example.org; only the owner can rename it' }]);

  const unknown = planProjectRenames(projects, { search: 'draft', replace: 'final' });
  assert.equal(unknown.planned.length, 3, 'without an account id nothing is skipped');
});
