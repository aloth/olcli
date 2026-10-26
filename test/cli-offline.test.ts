import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

// Runs the real entry points in a child process with an empty HOME, an empty
// working directory and no OVERLEAF_* or OLCLI_* variables, so no stored
// session and no .olauth file is ever involved. Where a test needs Overleaf, it
// gets a local HTTP server on 127.0.0.1; nothing here reaches the network or
// touches the credentials of whoever runs the suite.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TSX = import.meta.resolve('tsx');
const PROJECT_ID = '0123456789abcdef01234567';

let home: string;
let cwd: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'olcli-offline-'));
  cwd = join(home, 'work');
  mkdirSync(cwd);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('OVERLEAF_') || key.startsWith('OLCLI_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    APPDATA: join(home, 'AppData'),
    NODE_NO_WARNINGS: '1',
    NO_COLOR: '1',
    ...extra,
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
}

// Asynchronous on purpose: a synchronous spawn would block the event loop
// that serves the mock Overleaf below.
function run(script: string, args: string[], options: RunOptions = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, join(SRC, script), ...args], {
      cwd: options.cwd ?? cwd,
      env: cleanEnv(options.env),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf-8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}

function olcli(args: string[], options: RunOptions = {}): Promise<Run> {
  return run('cli.ts', args, options);
}

interface MockOverleaf {
  baseUrl: string;
  /** Every request as "METHOD /path", in order. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * The two pages a read-only command needs: the project list (which also
 * carries the CSRF token) and the project zip. With `loggedIn: false` the list
 * is a login form, which is how Overleaf answers an expired session.
 */
async function mockOverleaf(options: { loggedIn: boolean; files?: Record<string, string> }): Promise<MockOverleaf> {
  const requests: string[] = [];
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(options.files ?? {})) {
    zip.addFile(path, Buffer.from(content));
  }
  const zipBuffer = zip.toBuffer();
  const projects = JSON.stringify({ projects: [{ id: PROJECT_ID, name: 'Paper', lastUpdated: '2026-01-01T00:00:00.000Z' }] });
  const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/project') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(options.loggedIn
        ? `<html><head><meta name="ol-csrfToken" content="csrf"><meta name="ol-prefetchedProjectsBlob" content="${attribute(projects)}"></head></html>`
        : '<html><body><form name="loginForm"><input name="email"><input name="password" type="password"></form></body></html>');
      return;
    }
    if (req.method === 'GET' && req.url === `/project/${PROJECT_ID}/download/zip` && options.loggedIn) {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(zipBuffer);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function sessionEnv(mock: MockOverleaf): Record<string, string> {
  return { OVERLEAF_SESSION: 'test-session', OVERLEAF_BASE_URL: mock.baseUrl };
}

test('remote helper without credentials names an existing login command', async () => {
  const gitDir = join(home, 'helper.git');
  const result = await run(
    'remote-helper.ts',
    ['origin', `https://www.overleaf.com/project/${PROJECT_ID}`],
    { input: 'capabilities\n\nimport refs/heads/main\n\n', env: { GIT_DIR: gitDir } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No Overleaf credentials found/);
  assert.doesNotMatch(result.stderr, /olcli login/);

  const named = result.stderr.match(/Run '(olcli [a-z-]+)'/);
  assert.ok(named, `expected a command suggestion in: ${result.stderr}`);
  assert.equal(named[1], 'olcli auth');

  const help = await olcli(['auth', '--help']);
  assert.equal(help.status, 0, help.stderr);
});

test('sync --dry-run --verbose lists planned remote deletions without deleting', async () => {
  const mock = await mockOverleaf({ loggedIn: true, files: { 'main.tex': 'main\n', 'old.tex': 'old\n' } });
  try {
    for (const args of [['sync', '--dry-run', '--verbose'], ['--verbose', 'sync', '--dry-run']]) {
      const dir = mkdtempSync(join(home, 'sync-'));
      writeFileSync(join(dir, 'main.tex'), 'main\n');
      // old.tex was on the remote at the last sync and has been deleted locally.
      const meta = {
        projectId: PROJECT_ID,
        projectName: 'Paper',
        lastPull: '2026-01-01T00:00:00.000Z',
        remoteManifest: ['main.tex', 'old.tex'],
      };
      writeFileSync(join(dir, '.olcli.json'), JSON.stringify(meta));

      const result = await olcli(args, { cwd: dir, env: sessionEnv(mock) });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 deleted on remote/);
      assert.match(result.stdout, /Deleted on remote \(matched local deletion\):\s+old\.tex/, `${args.join(' ')}:\n${result.stdout}`);
      assert.ok(!existsSync(join(dir, 'old.tex')), 'dry run must not restore the deleted file');
    }
    assert.ok(mock.requests.every((r) => r.startsWith('GET ')), `dry run sent a write: ${mock.requests.join(', ')}`);
  } finally {
    await mock.close();
  }
});

test('sync without --verbose prints only the summary', async () => {
  const mock = await mockOverleaf({ loggedIn: true, files: { 'main.tex': 'main\n', 'old.tex': 'old\n' } });
  try {
    const dir = mkdtempSync(join(home, 'sync-'));
    writeFileSync(join(dir, 'main.tex'), 'main\n');
    writeFileSync(join(dir, '.olcli.json'), JSON.stringify({
      projectId: PROJECT_ID,
      projectName: 'Paper',
      lastPull: '2026-01-01T00:00:00.000Z',
      remoteManifest: ['main.tex', 'old.tex'],
    }));
    const result = await olcli(['sync', '--dry-run'], { cwd: dir, env: sessionEnv(mock) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 deleted on remote/);
    assert.doesNotMatch(result.stdout, /Deleted on remote \(matched local deletion\)/);
  } finally {
    await mock.close();
  }
});
