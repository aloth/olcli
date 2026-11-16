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
  RejectConflictError,
  nearestIndex,
  generateIdSeed
} from '../src/tracked-changes.js';
import { OverleafClient, SuggestionPermissionError } from '../src/client.js';

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

test('surroundingChars returns the visible text around each change, and nothing by default', async () => {
  const client: any = new OverleafClient({ cookies: { session: 's' }, csrf: 'c' });
  client.getProjectInfo = async () => ({ rootFolder: [{ docs: [{ _id: 'd1', name: 'main.tex' }, { _id: 'd2', name: 'a.tex' }], folders: [] }] });
  client.getCommentThreads = async () => ({});
  client.getChangesUsers = async () => [];
  client.openProjectSocket = async () => ({});
  client.closeProjectSocket = async () => {};
  client.joinDocument = async (_s: object, docId: string) => docId === 'd1'
    ? { docId, content: 'line one\nfoo quux baz', lines: [], version: 3, type: 'sharejs-text-ot',
      ranges: { changes: [{ id: 'c1', op: { i: 'quux', p: 13 }, metadata: {} }, { id: 'c2', op: { d: 'gone', p: 4 }, metadata: {} }] } }
    : { docId, content: 'x', lines: ['x'], version: 1, type: 'history-ot',
      ranges: { content: 'xyz', trackedChanges: [{ range: { pos: 1, length: 1 }, tracking: { type: 'delete', userId: 'u9' } }] } };

  const around = (await client.listReview('p', { surroundingChars: 5 })).changes.map((c: any) => [c.path, c.text, c.before, c.after]);
  assert.deepEqual(around, [
    ['a.tex', 'y', 'x', 'z'],
    ['main.tex', 'gone', 'line', ' one\n'],
    ['main.tex', 'quux', '\nfoo ', ' baz']
  ]);
  const plain = (await client.listTrackedChanges('p')).map((c: any) => [c.before, c.after]);
  assert.deepEqual(plain, [[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
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

test('acceptTrackedChangesInDoc posts once and reads nothing', async () => {
  const { client, state } = reviewClient('foo quux baz', replaced);
  let listed = 0;
  client.joinDocument = async () => { listed++; throw new Error('must not list'); };
  await client.acceptTrackedChangesInDoc('p', 'd1', ['i']);
  assert.equal(listed, 0);
  assert.deepEqual(state.posts.map((x: any) => [x.url.replace(/^.*\/project/, '/project'), x.body]), [['/project/p/doc/d1/changes/accept', { change_ids: ['i'] }]]);
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

/**
 * A client whose socket is a small stand-in for Overleaf: it applies the ops
 * to the text and, for an update with `meta.tc`, records a tracked delete
 * and insert the way the ranges tracker names them (seed plus counter).
 * `track: false` drops the tracking, like a server that ignored `meta.tc`.
 */
function suggestionClient(content: string, options: { ranges?: any; track?: boolean; permissionsLevel?: string; rejectUntracked?: 'error' | 'no-ack' } = {}) {
  const client: any = new OverleafClient({ cookies: {}, csrf: 'c' });
  const state = { content, version: 7, ranges: options.ranges ?? { changes: [] as any[] }, sent: [] as any[], joins: 0 };
  client.suggestionVerifyDelaysMs = [0, 0];
  client.getProjectInfo = async () => ({ rootFolder: [{ docs: [{ _id: 'd1', name: 'main.tex' }], folders: [] }] });
  client.openProjectSocket = async () => (options.permissionsLevel ? { permissionsLevel: options.permissionsLevel } : {});
  client.closeProjectSocket = async () => {};
  client.joinDocument = async () => {
    state.joins++;
    return { docId: 'd1', content: state.content, lines: [], version: state.version, type: 'sharejs-text-ot', ranges: JSON.parse(JSON.stringify(state.ranges)) };
  };
  client.socketRpc = async (_s: object, name: string, args: any[]) => {
    const update = args[1];
    if (!update.meta?.tc && options.rejectUntracked === 'error') throw new Error(`${name} failed: not authorized`);
    if (!update.meta?.tc && options.rejectUntracked === 'no-ack') throw new Error(`${name} did not return an acknowledgement`);
    state.sent.push([name, update]);
    state.content = applyTextOps(state.content, update.op);
    if (update.meta?.tc && options.track !== false) {
      let counter = 0;
      const id = () => `${update.meta.tc}${(++counter).toString(16).padStart(6, '0')}`;
      const del = update.op.find((op: any) => typeof op.d === 'string');
      const ins = update.op.find((op: any) => typeof op.i === 'string');
      if (del) state.ranges.changes.push({ id: id(), op: { d: del.d, p: del.p + (ins ? ins.i.length : 0) }, metadata: { user_id: 'u1' } });
      if (ins) state.ranges.changes.push({ id: id(), op: { i: ins.i, p: ins.p }, metadata: { user_id: 'u1' } });
    }
    state.version++;
    return [];
  };
  return { client, state };
}

test('suggestChanges undoes a pushed edit untracked, redoes it tracked, and leaves unpushed edits alone', async () => {
  const { client, state } = suggestionClient('The new cat sat. The new dog.');
  const sent = state.sent;

  const res = await client.suggestChanges('p', '/main.tex', [
    { before: 'The ', deleted: 'old', inserted: 'new', after: ' dog', hint: 21 },
    { before: 'cat ', deleted: 'sat', inserted: 'ran', after: '.', hint: 12 },
    { before: 'zzz', deleted: 'a', inserted: 'b', after: 'zzz', hint: 0 }
  ]);

  assert.deepEqual(res, ['done', 'not-pushed', 'not-found']);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0][1].op, [{ p: 21, d: 'new' }, { p: 21, i: 'old' }], 'the nearest "The new" is the second one');
  assert.equal(sent[0][1].meta, undefined);
  assert.deepEqual(sent[1][1].op, [{ p: 21, d: 'old' }, { p: 21, i: 'new' }]);
  assert.match(sent[1][1].meta.tc, /^[0-9a-f]{18}$/);
  assert.deepEqual([sent[0][1].v, sent[1][1].v], [7, 8]);
  assert.equal(state.content, 'The new cat sat. The new dog.');
});

test('suggestChanges: an edit with nothing to search for returns invalid instead of hanging', async () => {
  const { client, state } = suggestionClient('alpha gamma delta');
  const res = await Promise.race([
    client.suggestChanges('p', 'main.tex', [
      { before: '', deleted: 'gamma ', inserted: '', after: '', hint: 6 },
      { before: '', deleted: '', inserted: '', after: '', hint: 0 }
    ]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('suggestChanges hung')), 2000))
  ]);
  assert.deepEqual(res, ['invalid', 'invalid']);
  assert.equal(state.sent.length, 0);
});

test('nearestIndex returns -1 for an empty needle instead of looping', () => {
  assert.equal(nearestIndex('abc', '', 3), -1);
  assert.equal(nearestIndex('abcabc', 'bc', 4), 4);
  assert.equal(nearestIndex('abc', 'x', 0), -1);
});

test('suggestChanges: the same edit twice is done, then already-tracked, and sent once', async () => {
  const { client, state } = suggestionClient('alpha beta delta.');
  const edit = { before: 'alpha ', deleted: 'gamma', inserted: 'beta', after: ' delta', hint: 6 };
  assert.deepEqual(await client.suggestChanges('p', 'main.tex', [edit]), ['done']);
  assert.deepEqual(await client.suggestChanges('p', 'main.tex', [edit]), ['already-tracked']);
  assert.equal(state.sent.length, 2, 'one undo and one redo in total');
  assert.deepEqual(state.ranges.changes.map((c: any) => c.op), [{ d: 'gamma', p: 10 }, { i: 'beta', p: 6 }], 'the delete is not doubled');
  // In one call, a repeated edit is caught too.
  const again = suggestionClient('alpha beta delta.');
  assert.deepEqual(await again.client.suggestChanges('p', 'main.tex', [edit, edit]), ['done', 'already-tracked']);
  assert.equal(again.state.sent.length, 2);
});

test('suggestChanges: a pure insert or delete that is already tracked is not sent again', async () => {
  const ins = suggestionClient('a new b', { ranges: { changes: [{ id: 'x1', op: { i: 'new ', p: 2 }, metadata: {} }] } });
  assert.deepEqual(await ins.client.suggestChanges('p', 'main.tex', [{ before: 'a ', deleted: '', inserted: 'new ', after: 'b', hint: 2 }]), ['already-tracked']);
  const del = suggestionClient('a b', { ranges: { changes: [{ id: 'x2', op: { d: 'old ', p: 2 }, metadata: {} }] } });
  assert.deepEqual(await del.client.suggestChanges('p', 'main.tex', [{ before: 'a ', deleted: 'old ', inserted: '', after: 'b', hint: 2 }]), ['already-tracked']);
  assert.equal(ins.state.sent.length + del.state.sent.length, 0);
});

test('suggestChanges: reports not-tracked when the doc has no tracked change after writing', async () => {
  const { client, state } = suggestionClient('alpha beta delta.', { track: false });
  const res = await client.suggestChanges('p', 'main.tex', [{ before: 'alpha ', deleted: 'gamma', inserted: 'beta', after: ' delta', hint: 6 }]);
  assert.deepEqual(res, ['not-tracked']);
  assert.equal(state.sent.length, 2);
  assert.equal(state.joins, 3, 'one join to plan, then one read-back per delay');
  assert.equal(state.content, 'alpha beta delta.', 'the text is as before');
});

test('suggestChanges: review-only access is refused with a permission error before anything is sent', async () => {
  const known = suggestionClient('alpha beta delta.', { permissionsLevel: 'review' });
  await assert.rejects(
    known.client.suggestChanges('p', 'main.tex', [{ before: 'alpha ', deleted: 'gamma', inserted: 'beta', after: ' delta', hint: 6 }]),
    (err: Error) => err.name === 'SuggestionPermissionError' && /needs edit access/.test(err.message) && /review-only access cannot/.test(err.message)
  );
  assert.equal(known.state.sent.length, 0);
  for (const mode of ['error', 'no-ack'] as const) {
    const live = suggestionClient('alpha beta delta.', { rejectUntracked: mode });
    await assert.rejects(
      live.client.suggestChanges('p', 'main.tex', [{ before: 'alpha ', deleted: 'gamma', inserted: 'beta', after: ' delta', hint: 6 }]),
      (err: Error) => err instanceof SuggestionPermissionError && /needs edit access/.test(err.message),
      mode
    );
    assert.equal(live.state.sent.length, 0, `${mode}: no tracked redo after a refused undo`);
  }
});

test('generateIdSeed: 18 hex digits, the first 8 are the current time in seconds', () => {
  const seed = generateIdSeed();
  assert.match(seed, /^[0-9a-f]{18}$/);
  const seconds = parseInt(seed.slice(0, 8), 16);
  assert.ok(Math.abs(seconds - Date.now() / 1000) < 5, `timestamp part ${seconds}`);
  assert.equal(generateIdSeed(0x6a000000 * 1000, () => 0), '6a0000000000000000');
  assert.equal(generateIdSeed(1000, () => 0.999999999), '00000001ffffff7ffe');
});

test('suggestChanges sends meta.tc with a timestamp seed', async () => {
  const { client, state } = suggestionClient('alpha beta delta.');
  await client.suggestChanges('p', 'main.tex', [{ before: 'alpha ', deleted: 'gamma', inserted: 'beta', after: ' delta', hint: 6 }]);
  const tc = state.sent[1][1].meta.tc;
  assert.ok(Math.abs(parseInt(tc.slice(0, 8), 16) - Date.now() / 1000) < 5);
});

test('suggestChanges: inserted equal to deleted is unchanged, not not-pushed', async () => {
  const { client, state } = suggestionClient('alpha beta delta.');
  assert.deepEqual(await client.suggestChanges('p', 'main.tex', [{ before: 'alpha ', deleted: 'beta', inserted: 'beta', after: ' delta', hint: 6 }]), ['unchanged']);
  assert.equal(state.sent.length, 0);
});

test('suggestChanges refuses history-ot docs', async () => {
  const client: any = new OverleafClient({ cookies: {}, csrf: 'c' });
  client.getProjectInfo = async () => ({ rootFolder: [{ docs: [{ _id: 'd1', name: 'main.tex' }], folders: [] }] });
  client.openProjectSocket = async () => ({});
  let closed = false;
  client.closeProjectSocket = async () => { closed = true; };
  client.joinDocument = async () => ({ docId: 'd1', content: 'x', lines: ['x'], version: 1, type: 'history-ot', ranges: {} });
  await assert.rejects(client.suggestChanges('p', 'main.tex', []), /history-ot/);
  assert.equal(closed, true);
});

test('the package entry exports the tracked-change API', async () => {
  const entry = await import('../src/index.js');
  assert.equal(entry.RejectConflictError, RejectConflictError);
  const change: import('../src/index.js').TrackedChange | undefined = undefined;
  assert.equal(change, undefined);
});
