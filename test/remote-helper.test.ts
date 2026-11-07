import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

// Drives the real git binary against git-remote-overleaf and a local fake
// Overleaf on 127.0.0.1. Covers the bug where git fetch never saw edits made
// on Overleaf after the clone and git push then overwrote them.

const run = promisify(execFile);
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TSX = import.meta.resolve('tsx');
const PROJECT_ID = '0123456789abcdef01234567';
const ROOT_FOLDER = '0123456789abcdef01234566';

let home: string;
let bin: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'olcli-remote-'));
  bin = join(home, 'bin');
  mkdirSync(bin);
  const shim = join(bin, 'git-remote-overleaf');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" --import "${TSX}" "${join(SRC, 'remote-helper.ts')}" "$@"\n`);
  chmodSync(shim, 0o755);
});

after(() => rmSync(home, { recursive: true, force: true }));

interface FakeOverleaf {
  url: string;
  files: Map<string, string>;
  uploads: string[];
  close(): Promise<void>;
}

/** Project page, project zip and upload: what clone, fetch and push need. */
async function fakeOverleaf(initial: Record<string, string>): Promise<FakeOverleaf> {
  const files = new Map(Object.entries(initial));
  const uploads: string[] = [];
  const meta = JSON.stringify({ _id: PROJECT_ID, rootFolder: [{ _id: ROOT_FOLDER, name: 'rootFolder', docs: [], fileRefs: [], folders: [] }] })
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/project') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><meta name="ol-csrfToken" content="csrf"><meta name="ol-usersEmail" content="me@example.com"></head></html>');
      return;
    }
    if (req.method === 'GET' && url === `/project/${PROJECT_ID}`) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><meta name="ol-csrfToken" content="csrf"><meta name="ol-project" content="${meta}"></head></html>`);
      return;
    }
    if (req.method === 'GET' && url === `/project/${PROJECT_ID}/download/zip`) {
      const zip = new AdmZip();
      for (const [path, content] of files) zip.addFile(path, Buffer.from(content));
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(zip.toBuffer());
      return;
    }
    if (req.method === 'POST' && url.startsWith(`/project/${PROJECT_ID}/upload`)) {
      const form = await new Request('http://local/', {
        method: 'POST', headers: { 'content-type': String(req.headers['content-type']) }, body: Buffer.concat(chunks),
      }).formData();
      const name = String(form.get('name'));
      files.set(name, await (form.get('qqfile') as Blob).text());
      uploads.push(name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, entity_id: 'e1', entity_type: 'doc' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `overleaf::http://127.0.0.1:${address.port}/project/${PROJECT_ID}`,
    files,
    uploads,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function git(cwd: string, ...args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('OVERLEAF_') && !k.startsWith('OLCLI_') && !k.startsWith('GIT_')) env[k] = v;
  Object.assign(env, {
    HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NODE_NO_WARNINGS: '1',
    PATH: `${bin}:${process.env.PATH}`, OVERLEAF_SESSION: 'test-session',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  });
  try {
    const r = await run('git', args, { cwd, env, timeout: 60_000 });
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function clone(overleaf: FakeOverleaf, name: string): Promise<string> {
  const r = await git(home, 'clone', '-q', overleaf.url, name);
  assert.ok(r.ok, r.stderr);
  return join(home, name);
}

const commits = async (dir: string) => (await git(dir, 'rev-list', '--count', 'HEAD')).stdout.trim();

test('git pull brings in an edit made on Overleaf after the clone', async () => {
  const overleaf = await fakeOverleaf({ 'main.tex': 'one\n' });
  try {
    const dir = await clone(overleaf, 'pull');
    overleaf.files.set('main.tex', 'one\ncoauthor\n');
    const r = await git(dir, 'pull', '-q', '--no-rebase');
    assert.ok(r.ok, r.stderr);
    assert.equal(readFileSync(join(dir, 'main.tex'), 'utf-8'), 'one\ncoauthor\n');
    assert.equal(await commits(dir), '2');
  } finally {
    await overleaf.close();
  }
});

test('git fetch without a change on Overleaf writes no commit', async () => {
  const overleaf = await fakeOverleaf({ 'main.tex': 'one\n' });
  try {
    const dir = await clone(overleaf, 'idle');
    for (let i = 0; i < 2; i++) assert.ok((await git(dir, 'fetch', '-q')).ok);
    assert.equal((await git(dir, 'rev-list', '--count', 'origin/main')).stdout.trim(), '1');
  } finally {
    await overleaf.close();
  }
});

test('git push is refused while Overleaf has edits the clone has not fetched', async () => {
  const overleaf = await fakeOverleaf({ 'main.tex': 'one\n' });
  try {
    const dir = await clone(overleaf, 'refuse');
    overleaf.files.set('main.tex', 'one\ncoauthor\n');
    writeFileSync(join(dir, 'main.tex'), 'one\nmine\n');
    await git(dir, 'commit', '-qam', 'mine');
    const r = await git(dir, 'push', '-q');
    assert.equal(r.ok, false);
    assert.match(r.stderr, /Overleaf has changes you do not have yet \(main\.tex\)/);
    assert.equal(overleaf.files.get('main.tex'), 'one\ncoauthor\n', 'the coauthor edit survives');
    assert.deepEqual(overleaf.uploads, []);
  } finally {
    await overleaf.close();
  }
});

test('after git pull the push goes through and keeps both edits', async () => {
  const overleaf = await fakeOverleaf({ 'main.tex': 'one\n', 'refs.bib': '@a\n' });
  try {
    const dir = await clone(overleaf, 'merge');
    overleaf.files.set('refs.bib', '@a\n@coauthor\n');
    writeFileSync(join(dir, 'main.tex'), 'one\nmine\n');
    await git(dir, 'commit', '-qam', 'mine');
    assert.equal((await git(dir, 'push', '-q')).ok, false);
    const pulled = await git(dir, 'pull', '-q', '--no-rebase', '--no-edit');
    assert.ok(pulled.ok, pulled.stderr);
    const pushed = await git(dir, 'push', '-q');
    assert.ok(pushed.ok, pushed.stderr);
    assert.equal(overleaf.files.get('main.tex'), 'one\nmine\n');
    assert.equal(overleaf.files.get('refs.bib'), '@a\n@coauthor\n');
    // Our own upload is recorded, so the next push is not refused.
    writeFileSync(join(dir, 'main.tex'), 'one\nmine\nmore\n');
    await git(dir, 'commit', '-qam', 'more');
    const again = await git(dir, 'push', '-q');
    assert.ok(again.ok, again.stderr);
  } finally {
    await overleaf.close();
  }
});

test('git push --force overwrites edits made on Overleaf', async () => {
  const overleaf = await fakeOverleaf({ 'main.tex': 'one\n' });
  try {
    const dir = await clone(overleaf, 'force');
    overleaf.files.set('main.tex', 'one\ncoauthor\n');
    writeFileSync(join(dir, 'main.tex'), 'one\nmine\n');
    await git(dir, 'commit', '-qam', 'mine');
    const r = await git(dir, 'push', '-q', '--force');
    assert.ok(r.ok, r.stderr);
    assert.equal(overleaf.files.get('main.tex'), 'one\nmine\n');
  } finally {
    await overleaf.close();
  }
});

test('a clone without a record of the Overleaf state must pull once before pushing', async () => {
  const overleaf = await fakeOverleaf({ 'main.tex': 'one\n' });
  try {
    const dir = await clone(overleaf, 'legacy');
    const statePath = join(dir, '.git', 'overleaf', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    delete state.remoteHashes;
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(join(dir, 'main.tex'), 'one\nmine\n');
    await git(dir, 'commit', '-qam', 'mine');
    const refused = await git(dir, 'push', '-q');
    assert.equal(refused.ok, false);
    assert.match(refused.stderr, /no record of the Overleaf state.*git pull once/);
    assert.ok((await git(dir, 'pull', '-q', '--no-rebase', '--no-edit')).ok);
    const pushed = await git(dir, 'push', '-q');
    assert.ok(pushed.ok, pushed.stderr);
    assert.equal(overleaf.files.get('main.tex'), 'one\nmine\n');
  } finally {
    await overleaf.close();
  }
});

test('git push is refused when the pushed commit does not contain the last fetch', async () => {
  const overleaf = await fakeOverleaf({ 'main.tex': 'one\n' });
  try {
    const dir = await clone(overleaf, 'unmerged');
    overleaf.files.set('main.tex', 'one\ncoauthor\n');
    writeFileSync(join(dir, 'main.tex'), 'one\nmine\n');
    await git(dir, 'commit', '-qam', 'mine');
    // Fetched, but not merged (as after a merge conflict that was left alone).
    assert.ok((await git(dir, 'fetch', '-q')).ok);
    const r = await git(dir, 'push', '-q');
    assert.equal(r.ok, false, 'push must not go through');
    assert.equal(overleaf.files.get('main.tex'), 'one\ncoauthor\n', 'the coauthor edit survives');
  } finally {
    await overleaf.close();
  }
});
