import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OverleafClient, resolveCommentConcurrency } from '../src/client.js';

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function withServer(
  response: { status?: number; body: unknown; headers?: Record<string, string> },
  run: (baseUrl: string, getRequest: () => CapturedRequest | undefined) => Promise<void>
): Promise<void> {
  let request: CapturedRequest | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf-8')
    };
    res.writeHead(response.status ?? 200, {
      'Content-Type': 'application/json',
      ...response.headers
    });
    res.end(JSON.stringify(response.body));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    await run(`http://127.0.0.1:${address.port}`, () => request);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

test('createProject creates a blank project and maps the response', async () => {
  await withServer(
    {
      body: { project_id: '0123456789abcdef01234567', owner_ref: 'owner-id' },
      headers: { 'Set-Cookie': 'refreshed=session; Path=/' }
    },
    async (baseUrl, getRequest) => {
      const client = new OverleafClient({
        cookies: { session: 'secret' },
        csrf: 'csrf-token',
        baseUrl
      });

      const created = await client.createProject('  My Paper  ');

      assert.deepEqual(created, {
        id: '0123456789abcdef01234567',
        name: 'My Paper',
        url: `${baseUrl}/project/0123456789abcdef01234567`,
        ownerId: 'owner-id'
      });
      assert.equal(client.getCookie('refreshed'), 'session');
      assert.deepEqual(JSON.parse(getRequest()?.body ?? ''), { projectName: 'My Paper' });
      assert.equal(getRequest()?.method, 'POST');
      assert.equal(getRequest()?.url, '/project/new');
      assert.equal(getRequest()?.headers['content-type'], 'application/json');
      assert.equal(getRequest()?.headers['x-csrf-token'], 'csrf-token');
    }
  );
});

test('createProject requests the example template', async () => {
  await withServer(
    { body: { project_id: '0123456789abcdef01234567' } },
    async (baseUrl, getRequest) => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await client.createProject('Example Paper', { template: 'example' });
      assert.deepEqual(JSON.parse(getRequest()?.body ?? ''), {
        projectName: 'Example Paper',
        template: 'example'
      });
    }
  );
});

test('createProject rejects invalid input before making a request', async () => {
  const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token' });
  await assert.rejects(client.createProject('  '), /Project name must not be empty/);
  await assert.rejects(
    client.createProject('Paper', { template: 'unsupported' as 'blank' }),
    /Unsupported project template: unsupported/
  );
});

test('createProject reports HTTP errors and malformed success responses', async () => {
  await withServer(
    { status: 403, body: { message: 'forbidden' } },
    async baseUrl => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await assert.rejects(client.createProject('Paper'), /Session expired or invalid\. Run: olcli auth/);
    }
  );

  await withServer(
    { body: {} },
    async baseUrl => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await assert.rejects(client.createProject('Paper'), /response did not include a project ID/);
    }
  );
});

test('listComments joins docs over several sockets, not one doc at a time on one socket', async () => {
  const client: any = new OverleafClient({ cookies: { session: 'secret' }, csrf: 'csrf-token' });
  const docs = Array.from({ length: 10 }, (_, i) => ({ _id: `doc${i}`, name: `f${i}.tex` }));
  client.getProjectInfo = async () => ({ rootFolder: [{ docs, folders: [] }] });
  client.getCommentThreads = async () => ({});

  let open = 0;
  const sessions = new Set<object>();
  const joinedBy = new Map<string, object>();
  client.openProjectSocket = async () => {
    const session = {};
    sessions.add(session);
    open++;
    return session;
  };
  client.closeProjectSocket = async () => { open--; };
  client.joinDocument = async (session: object, docId: string) => {
    joinedBy.set(docId, session);
    await new Promise(resolve => setTimeout(resolve, 5));
    const index = Number(docId.slice(3));
    return {
      docId,
      content: 'hello world',
      lines: ['hello world'],
      version: 1,
      type: 'sharejs-text-ot',
      ranges: index === 7 ? { comments: [{ op: { c: 'world', p: 6, t: 'thread7' } }] } : {}
    };
  };

  const comments = await client.listComments('project');

  assert.equal(joinedBy.size, 10);
  assert(sessions.size > 1 && sessions.size <= 4, `expected 2-4 sockets, got ${sessions.size}`);
  assert.equal(open, 0, 'every socket is closed');
  assert.deepEqual(comments.map((c: any) => [c.threadId, c.path]), [['thread7', 'f7.tex']]);
});

function poolClient(docCount: number, opts: { failDoc?: string; openStatus?: (n: number) => number | undefined } = {}) {
  const client: any = new OverleafClient({ cookies: { session: 'secret' }, csrf: 'csrf-token' });
  const docs = Array.from({ length: docCount }, (_, i) => ({ _id: `doc${i}`, name: `f${i}.tex` }));
  client.getProjectInfo = async () => ({ rootFolder: [{ docs, folders: [] }] });
  client.getCommentThreads = async () => ({});
  const stats = { open: 0, opened: 0, joins: 0, joinsAfterFailure: 0, failed: false };
  client.openProjectSocket = async () => {
    const status = opts.openStatus?.(stats.opened);
    stats.opened++;
    if (status) throw Object.assign(new Error(`Failed to open project socket: ${status}`), { status });
    stats.open++;
    return {};
  };
  client.closeProjectSocket = async () => { stats.open--; };
  client.joinDocument = async (_session: object, docId: string) => {
    stats.joins++;
    if (stats.failed) stats.joinsAfterFailure++;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (docId === opts.failDoc) { stats.failed = true; throw new Error(`joinDoc failed: forbidden ${docId}`); }
    return { docId, content: '', lines: [''], version: 1, type: 'sharejs-text-ot', ranges: {} };
  };
  return { client, stats };
}

test('listComments stops joining after the first failure and closes every socket before rejecting', async () => {
  const { client, stats } = poolClient(20, { failDoc: 'doc2' });
  await assert.rejects(client.listComments('project'), /forbidden doc2/);
  assert.equal(stats.open, 0, 'every socket is closed when the error surfaces');
  assert.equal(stats.joinsAfterFailure, 0, 'no join starts after the failure');
  assert(stats.joins < 20, `expected an early stop, got ${stats.joins} joins`);
});

test('listComments drops rate-limited extra sockets and finishes on the rest', async () => {
  const { client, stats } = poolClient(10, { openStatus: n => (n > 0 ? 429 : undefined) });
  const comments = await client.listComments('project');
  assert.deepEqual(comments, []);
  assert.equal(stats.joins, 10);
  assert.equal(stats.open, 0);
});

test('listComments fails when the first socket cannot open', async () => {
  const { client, stats } = poolClient(5, { openStatus: n => (n === 0 ? 429 : undefined) });
  await assert.rejects(client.listComments('project'), /429/);
  assert.equal(stats.joins, 0);
  assert.equal(stats.open, 0);
});

test('listComments honors the concurrency option', async () => {
  const { client, stats } = poolClient(10);
  await client.listComments('project', { concurrency: 1 });
  assert.equal(stats.opened, 1);
});

test('resolveCommentConcurrency reads option, then OLCLI_CONCURRENCY, then defaults to 4', () => {
  assert.equal(resolveCommentConcurrency(undefined, {}), 4);
  assert.equal(resolveCommentConcurrency(undefined, { OLCLI_CONCURRENCY: '2' }), 2);
  assert.equal(resolveCommentConcurrency('6', { OLCLI_CONCURRENCY: '2' }), 6);
  for (const bad of ['0', '9', '1.5', 'four']) {
    assert.throws(() => resolveCommentConcurrency(bad, {}), /1 to 8/);
  }
  assert.throws(() => resolveCommentConcurrency(undefined, { OLCLI_CONCURRENCY: '12' }), /OLCLI_CONCURRENCY=12/);
});

// ---------------------------------------------------------------------------
// rename | mv: rename, move, create folders, refuse before writing
// ---------------------------------------------------------------------------

const MOVE_PROJECT = '0123456789abcdef01234567';

/**
 * A project tree:
 *   main.tex, notes.txt, figures/{a.png, old/}, sub/{x.txt, notes.txt}
 */
function moveTree() {
  return {
    _id: 'root', name: 'rootFolder',
    docs: [{ _id: 'd-main', name: 'main.tex' }, { _id: 'd-notes', name: 'notes.txt' }],
    fileRefs: [],
    folders: [
      { _id: 'f-figures', name: 'figures', docs: [], fileRefs: [{ _id: 'r-a', name: 'a.png' }],
        folders: [{ _id: 'f-old', name: 'old', docs: [], fileRefs: [], folders: [] }] },
      { _id: 'f-sub', name: 'sub', docs: [{ _id: 'd-x', name: 'x.txt' }, { _id: 'd-subnotes', name: 'notes.txt' }], fileRefs: [], folders: [] },
    ],
  };
}

/** Serves the project page with the tree and records every request. */
async function withProjectServer(run: (client: OverleafClient, requests: CapturedRequest[]) => Promise<void>): Promise<void> {
  const requests: CapturedRequest[] = [];
  let folderCounter = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') });
    if (req.method === 'GET' && req.url === `/project/${MOVE_PROJECT}`) {
      const meta = JSON.stringify({ _id: MOVE_PROJECT, rootFolder: [moveTree()] }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><meta name="ol-project" content="${meta}"></head></html>`);
      return;
    }
    if (req.method === 'POST' && req.url === `/project/${MOVE_PROJECT}/folder`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ _id: `new-folder-${++folderCounter}` }));
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    const client = new OverleafClient({ cookies: { session: 's' }, csrf: 'csrf-token', baseUrl: `http://127.0.0.1:${address.port}` });
    await run(client, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const writes = (requests: CapturedRequest[]) =>
  requests.filter(r => r.method === 'POST').map(r => [r.url?.replace(`/project/${MOVE_PROJECT}`, ''), JSON.parse(r.body)]);

test('rename without a slash renames in place and does not move', async () => {
  await withProjectServer(async (client, requests) => {
    const result = await client.moveByPath(MOVE_PROJECT, 'sub/x.txt', 'y.txt');
    assert.deepEqual(result, { from: 'sub/x.txt', to: 'sub/y.txt', createdFolders: [] });
    assert.deepEqual(writes(requests), [['/doc/d-x/rename', { name: 'y.txt' }]]);
    assert.equal(requests.at(-1)?.headers['x-csrf-token'], 'csrf-token');
  });
});

test('a destination path in an existing folder renames, then moves', async () => {
  await withProjectServer(async (client, requests) => {
    const result = await client.moveByPath(MOVE_PROJECT, 'sub/x.txt', 'figures/y.txt');
    assert.equal(result.to, 'figures/y.txt');
    assert.deepEqual(writes(requests), [
      ['/doc/d-x/rename', { name: 'y.txt' }],
      ['/doc/d-x/move', { folder_id: 'f-figures' }],
    ]);
  });
});

test('a trailing slash moves and keeps the name; folders and files move too', async () => {
  await withProjectServer(async (client, requests) => {
    await client.moveByPath(MOVE_PROJECT, 'sub/x.txt', 'figures/');
    await client.moveByPath(MOVE_PROJECT, 'figures/a.png', 'sub/');
    await client.moveByPath(MOVE_PROJECT, 'figures/old', 'sub/');
    assert.deepEqual(writes(requests), [
      ['/doc/d-x/move', { folder_id: 'f-figures' }],
      ['/file/r-a/move', { folder_id: 'f-sub' }],
      ['/folder/f-old/move', { folder_id: 'f-sub' }],
    ]);
  });
});

test('"/" and a leading slash target the project root', async () => {
  await withProjectServer(async (client, requests) => {
    assert.equal((await client.moveByPath(MOVE_PROJECT, 'sub/x.txt', '/')).to, 'x.txt');
    assert.equal((await client.moveByPath(MOVE_PROJECT, 'sub/x.txt', '/top.txt')).to, 'top.txt');
    assert.deepEqual(writes(requests), [
      ['/doc/d-x/move', { folder_id: 'root' }],
      ['/doc/d-x/rename', { name: 'top.txt' }],
      ['/doc/d-x/move', { folder_id: 'root' }],
    ]);
  });
});

test('missing folders are created, parents first, then the entity moves into the deepest one', async () => {
  await withProjectServer(async (client, requests) => {
    const result = await client.moveByPath(MOVE_PROJECT, 'main.tex', 'figures/chapters/intro/intro.tex');
    assert.deepEqual(result.createdFolders, ['figures/chapters', 'figures/chapters/intro']);
    assert.deepEqual(writes(requests), [
      ['/doc/d-main/rename', { name: 'intro.tex' }],
      ['/folder', { parent_folder_id: 'f-figures', name: 'chapters' }],
      ['/folder', { parent_folder_id: 'new-folder-1', name: 'intro' }],
      ['/doc/d-main/move', { folder_id: 'new-folder-2' }],
    ]);
  });
});

test('when the new name is taken in the source folder, it moves first and renames after', async () => {
  await withProjectServer(async (client, requests) => {
    // sub/notes.txt exists, so renaming sub/x.txt to notes.txt in place would clash.
    await client.moveByPath(MOVE_PROJECT, 'sub/x.txt', 'figures/notes.txt');
    assert.deepEqual(writes(requests), [
      ['/doc/d-x/move', { folder_id: 'f-figures' }],
      ['/doc/d-x/rename', { name: 'notes.txt' }],
    ]);
  });
});

test('refusals happen before any write request', async () => {
  await withProjectServer(async (client, requests) => {
    // Clash in the target folder, in the same folder, at the root.
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'sub/x.txt', 'sub/notes.txt'), /Destination already exists: sub\/notes\.txt/);
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'sub/x.txt', '/notes.txt'), /Destination already exists: notes\.txt/);
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'sub/notes.txt', '/'), /Destination already exists: notes\.txt/);
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'figures', 'figures/'), /: Cannot move folder figures into itself$/);
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'figures', 'figures/old/'), /: Cannot move folder figures into its own subfolder figures\/old$/);
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'figures', 'figures/new/deeper/'), /: Cannot move folder figures into its own subfolder figures\/new\/deeper$/);
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'missing.tex', 'sub/'), /File not found: missing\.tex/);
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'sub/x.txt', 'main.tex/y.txt'), /main\.tex is a doc, not a folder/);
    await assert.rejects(client.moveByPath(MOVE_PROJECT, 'sub/x.txt', 'a/../y.txt'), /Invalid destination path/);
    assert.deepEqual(writes(requests), []);
  });
});

test('httpRequest retries 429 (honoring Retry-After), gives up after 5 retries, and can be told not to retry', async () => {
  const cases = [
    { failures: 2, options: {}, status: 200, calls: 3 },
    { failures: 99, options: {}, status: 429, calls: 6 },
    { failures: 99, options: { retryOn429: false }, status: 429, calls: 1 }
  ];
  for (const c of cases) {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      const limited = calls <= c.failures;
      res.writeHead(limited ? 429 : 200, { 'Content-Type': 'application/json', ...(limited ? { 'Retry-After': '0' } : {}) });
      res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const client = new OverleafClient({ cookies: { session: 's' }, csrf: 'c', baseUrl: `http://127.0.0.1:${port}` });
      const res = await (client as any).httpRequest(`http://127.0.0.1:${port}/x`, { expect: 'json', ...c.options });
      assert.equal(res.status, c.status);
      assert.equal(calls, c.calls);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});
