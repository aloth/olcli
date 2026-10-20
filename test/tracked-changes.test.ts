import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTextOps,
  buildUserDirectory,
  describeAuthor,
  formatAuthor,
  parseHistoryOtChanges,
  parseShareJsChanges,
  planRejection,
  RejectConflictError
} from '../src/tracked-changes.js';
import { OverleafClient } from '../src/client.js';

test('parseShareJsChanges reads inserts and deletes and skips malformed entries', () => {
  const changes = parseShareJsChanges({
    changes: [
      { id: 'a', op: { i: 'quux', p: 4 }, metadata: { user_id: 'u1', ts: '2026-10-01T10:00:00.000Z' } },
      { id: 'b', op: { d: 'bar', p: 8 }, metadata: { user_id: 'u2', ts: 1790000000000 } },
      { id: 'c', op: { p: 1 } },
      { op: { i: 'x', p: 0 } }
    ]
  });
  assert.deepEqual(changes.map(c => [c.id, c.kind, c.position, c.text, c.userId]), [
    ['a', 'insert', 4, 'quux', 'u1'],
    ['b', 'delete', 8, 'bar', 'u2']
  ]);
  assert.equal(changes[1].timestamp, new Date(1790000000000).toISOString());
});

test('parseHistoryOtChanges maps snapshot positions to visible positions', () => {
  // snapshot "foo quuxbar baz": insert "quux" at 4, tracked delete "bar" at 8
  const { changes, visibleContent } = parseHistoryOtChanges({
    content: 'foo quuxbar baz',
    trackedChanges: [
      { range: { pos: 8, length: 3 }, tracking: { type: 'delete', userId: 'u1', ts: 't' } },
      { range: { pos: 4, length: 4 }, tracking: { type: 'insert', userId: 'u1', ts: 't' } }
    ]
  });
  assert.equal(visibleContent, 'foo quux baz');
  assert.deepEqual(changes.map(c => [c.id, c.kind, c.position, c.text]), [
    ['change-insert-4', 'insert', 4, 'quux'],
    ['change-delete-8', 'delete', 8, 'bar']
  ]);
});

test('planRejection restores a replaced word', () => {
  const changes = parseShareJsChanges({
    changes: [
      { id: 'd', op: { d: 'bar', p: 8 }, metadata: {} },
      { id: 'i', op: { i: 'quux', p: 4 }, metadata: {} }
    ]
  });
  const plan = planRejection('foo quux baz', changes);
  assert.equal(plan.content, 'foo bar baz');
  assert.equal(applyTextOps('foo quux baz', plan.ops), 'foo bar baz');
  assert(plan.ops.every(op => op.u === true));
});

test('planRejection refuses a stale insert', () => {
  const changes = parseShareJsChanges({ changes: [{ id: 'i', op: { i: 'quux', p: 4 }, metadata: {} }] });
  assert.throws(() => planRejection('foo baz', changes), RejectConflictError);
});

test('author directory prefers members and formats names', () => {
  const users = buildUserDirectory(
    { owner: { _id: 'u1', email: 'a@x.org', first_name: 'Ann', last_name: 'Lee' }, members: [] },
    [{ id: 'u1', email: 'old@x.org' }, { id: 'u2', email: 'b@x.org' }]
  );
  assert.equal(formatAuthor(describeAuthor('u1', users)), 'Ann Lee <a@x.org>');
  assert.equal(formatAuthor(describeAuthor('u2', users)), 'b@x.org');
  assert.equal(formatAuthor(describeAuthor(null, users)), 'unknown user');
});

test('listReview returns comments and tracked changes from one pass with locations', async () => {
  const client: any = new OverleafClient({ cookies: { session: 's' }, csrf: 'c' });
  client.getProjectInfo = async () => ({
    owner: { _id: 'u1', email: 'a@x.org' },
    rootFolder: [{ docs: [{ _id: 'd1', name: 'main.tex' }], folders: [{ name: 'sec', docs: [{ _id: 'd2', name: 'a.tex' }], folders: [] }] }]
  });
  client.getCommentThreads = async () => ({});
  let usersCalls = 0;
  client.getChangesUsers = async () => { usersCalls++; return []; };
  client.openProjectSocket = async () => ({});
  client.closeProjectSocket = async () => {};
  let joins = 0;
  client.joinDocument = async (_s: object, docId: string) => {
    joins++;
    if (docId === 'd1') {
      return { docId, content: 'line one\nfoo quux baz', lines: [], version: 3, type: 'sharejs-text-ot',
        ranges: { changes: [{ id: 'c1', op: { i: 'quux', p: 13 }, metadata: { user_id: 'u1', ts: 't1' } }] } };
    }
    return { docId, content: 'x', lines: ['x'], version: 1, type: 'history-ot',
      ranges: { content: 'xy', trackedChanges: [{ range: { pos: 1, length: 1 }, tracking: { type: 'delete', userId: 'u9' } }] } };
  };

  const review = await client.listReview('p');
  assert.equal(joins, 2, 'each doc joined once');
  assert.equal(usersCalls, 1);
  assert.deepEqual(review.comments, []);
  assert.deepEqual(review.changes.map((c: any) => [c.id, c.kind, c.path, c.line, c.column, c.text, c.author]), [
    ['c1', 'insert', 'main.tex', 2, 5, 'quux', { id: 'u1', email: 'a@x.org' }],
    ['change-delete-1', 'delete', 'sec/a.tex', 1, 2, 'y', { id: 'u9' }]
  ]);
});

test('normalizeJoinedDocument decodes UTF-8 in tracked change texts', () => {
  const client: any = new OverleafClient({ cookies: {}, csrf: 'c' });
  const enc = (s: string) => Buffer.from(s, 'utf-8').toString('binary');
  const doc = client.normalizeJoinedDocument('d', [[enc('Grüße')], 1, [], { changes: [{ id: 'a', op: { i: enc('ü'), p: 2 } }, { id: 'b', op: { d: enc('ß'), p: 0 } }] }]);
  assert.equal(doc.ranges.changes[0].op.i, 'ü');
  assert.equal(doc.ranges.changes[1].op.d, 'ß');
});

function reviewClient(content: string, ranges: any, version = 5) {
  const client: any = new OverleafClient({ cookies: { session: 's' }, csrf: 'c' });
  const state = { content, ranges, version, sent: [] as any[], posts: [] as any[] };
  client.getProjectInfo = async () => ({ rootFolder: [{ docs: [{ _id: 'd1', name: 'main.tex' }], folders: [] }] });
  client.getChangesUsers = async () => [];
  client.openProjectSocket = async () => ({});
  client.closeProjectSocket = async () => {};
  client.joinDocument = async (_s: object, docId: string) => ({
    docId, content: state.content, lines: [], version: state.version, type: 'sharejs-text-ot', ranges: state.ranges
  });
  client.socketRpc = async (_s: object, name: string, args: any[]) => {
    state.sent.push({ name, args });
    state.content = applyTextOps(state.content, args[1].op);
    state.ranges = { changes: [] };
    state.version++;
    return [];
  };
  client.httpRequest = async (url: string, opts: any) => {
    state.posts.push({ url, body: JSON.parse(opts.body) });
    state.ranges = { changes: [] };
    return { ok: true, status: 200, headers: {}, body: '' };
  };
  return { client, state };
}

const replaced = { changes: [
  { id: 'd', op: { d: 'bar', p: 8 }, metadata: {} },
  { id: 'i', op: { i: 'quux', p: 4 }, metadata: {} }
] };

test('acceptTrackedChanges posts the ids per doc and verifies they are gone', async () => {
  const { client, state } = reviewClient('foo quux baz', replaced);
  const accepted = await client.acceptTrackedChanges('p', ['i', 'd', 'i']);
  assert.deepEqual(accepted.map((c: any) => c.id).sort(), ['d', 'i']);
  assert.equal(state.posts.length, 1);
  assert.match(state.posts[0].url, /\/project\/p\/doc\/d1\/changes\/accept$/);
  assert.deepEqual(state.posts[0].body.change_ids.sort(), ['d', 'i']);
});

test('acceptTrackedChanges sends nothing when an id is unknown', async () => {
  const { client, state } = reviewClient('foo quux baz', replaced);
  await assert.rejects(client.acceptTrackedChanges('p', ['i', 'nope']), /not found: nope/);
  assert.equal(state.posts.length, 0);
});

test('acceptTrackedChanges fails when Overleaf keeps the change', async () => {
  const { client, state } = reviewClient('foo quux baz', replaced);
  client.httpRequest = async (url: string, opts: any) => {
    state.posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, headers: {}, body: '' };
  };
  await assert.rejects(client.acceptTrackedChanges('p', ['i']), /did not accept: i/);
});

test('reject previews without writing, then applies the planned ops', async () => {
  const { client, state } = reviewClient('foo quux baz', replaced);
  const plan = await client.planTrackedChangeRejection('p', ['i', 'd']);
  assert.equal(state.sent.length, 0, 'planning writes nothing');
  assert.match(plan.docs[0].diff, /-foo quux baz/);
  assert.match(plan.docs[0].diff, /\+foo bar baz/);
  await client.rejectTrackedChanges('p', plan);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].args[1].v, 5);
  assert.equal(state.content, 'foo bar baz');
});

test('reject refuses to write when the doc moved since the preview', async () => {
  const { client, state } = reviewClient('foo quux baz', replaced);
  const plan = await client.planTrackedChangeRejection('p', ['i']);
  state.version = 6;
  await assert.rejects(client.rejectTrackedChanges('p', plan), RejectConflictError);
  assert.equal(state.sent.length, 0);
  assert.equal(state.content, 'foo quux baz');
});

test('reject refuses history-ot docs', async () => {
  const { client } = reviewClient('x', {});
  client.joinDocument = async (_s: object, docId: string) => ({
    docId, content: 'x', lines: ['x'], version: 1, type: 'history-ot',
    ranges: { content: 'xy', trackedChanges: [{ range: { pos: 1, length: 1 }, tracking: { type: 'delete' } }] }
  });
  await assert.rejects(client.planTrackedChangeRejection('p', ['change-delete-1']), /not supported/);
});

test('not found error explains premium only when the project has no tracked changes', async () => {
  const empty = reviewClient('foo', { changes: [] });
  await assert.rejects(empty.client.acceptTrackedChanges('p', ['x']), /no tracked changes; track changes requires the project owner to have an Overleaf premium plan/);
  const some = reviewClient('foo quux baz', replaced);
  await assert.rejects(some.client.acceptTrackedChanges('p', ['x']), (err: Error) => /not found: x$/.test(err.message));
});
