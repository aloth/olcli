import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
async function mockOverleaf(options: { loggedIn: boolean; files?: Record<string, string>; projectName?: string }): Promise<MockOverleaf> {
  const requests: string[] = [];
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(options.files ?? {})) {
    zip.addFile(path, Buffer.from(content));
  }
  const zipBuffer = zip.toBuffer();
  const projects = JSON.stringify({ projects: [{ id: PROJECT_ID, name: options.projectName ?? 'Paper', lastUpdated: '2026-01-01T00:00:00.000Z' }] });
  const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/project') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(options.loggedIn
        ? `<html><head><meta name="ol-csrfToken" content="csrf"><meta name="ol-usersEmail" content="me@example.com"><meta name="ol-prefetchedProjectsBlob" content="${attribute(projects)}"></head></html>`
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

function projectDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(home, 'project-'));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  writeFileSync(join(dir, '.olcli.json'), JSON.stringify({ projectId: PROJECT_ID, projectName: 'Paper' }));
  return dir;
}

test('diff --exit-code exits 2 when no credential is found, 1 without the flag', async () => {
  const gated = await olcli(['diff', '--exit-code']);
  assert.equal(gated.status, 2, gated.stderr);
  assert.match(gated.stderr, /No session cookie or password credentials found/);

  const plain = await olcli(['diff']);
  assert.equal(plain.status, 1, plain.stderr);
});

test('diff --exit-code exits 2 on usage errors, other commands keep 1', async () => {
  const unknown = await olcli(['diff', '--exit-code', '--bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option '--bogus'/);

  const before = await olcli(['diff', '--bogus', '--exit-code']);
  assert.equal(before.status, 2);

  const missingValue = await olcli(['diff', '--exit-code', '-U']);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /argument missing/);

  assert.equal((await olcli(['diff', '--bogus'])).status, 1);
  assert.equal((await olcli(['pull', '--bogus'])).status, 1);

  const help = await olcli(['diff', '--exit-code', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: olcli diff/);
});

test('diff --exit-code exits 2 on an invalid session and 0 or 1 on a real comparison', async () => {
  const expired = await mockOverleaf({ loggedIn: false });
  try {
    const result = await olcli(['diff', '--exit-code'], { cwd: projectDir({ 'main.tex': 'a\n' }), env: sessionEnv(expired) });
    assert.equal(result.status, 2, result.stdout + result.stderr);
  } finally {
    await expired.close();
  }

  const live = await mockOverleaf({ loggedIn: true, files: { 'main.tex': 'a\n' } });
  try {
    const same = await olcli(['diff', '--exit-code'], { cwd: projectDir({ 'main.tex': 'a\n' }), env: sessionEnv(live) });
    assert.equal(same.status, 0, same.stdout + same.stderr);
    const changed = await olcli(['diff', '--exit-code', '--name-only'], { cwd: projectDir({ 'main.tex': 'b\n' }), env: sessionEnv(live) });
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.match(changed.stdout, /main\.tex/);
  } finally {
    await live.close();
  }
});

test('whoami exits 1 when not authenticated or the session is invalid, 0 when valid', async () => {
  const none = await olcli(['whoami']);
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stdout, /Not signed in/);

  const expired = await mockOverleaf({ loggedIn: false });
  try {
    const result = await olcli(['whoami'], { env: sessionEnv(expired) });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Session expired or invalid\. Run: olcli auth/);
  } finally {
    await expired.close();
  }

  const live = await mockOverleaf({ loggedIn: true });
  try {
    const result = await olcli(['whoami'], { env: sessionEnv(live) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /valid, 1 project\(s\)/);
  } finally {
    await live.close();
  }
});

test('an expired session names the fix before the detail, on every command', async () => {
  const expired = await mockOverleaf({ loggedIn: false });
  try {
    for (const args of [['list'], ['info', 'Paper'], ['pull', 'Paper']]) {
      const result = await olcli(args, { env: sessionEnv(expired) });
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert.match(output, /Session expired or invalid\. Run: olcli auth/, args.join(' '));
      assert.doesNotMatch(output, /Failed: /, args.join(' '));
    }
  } finally {
    await expired.close();
  }
});

test('auth status shows instance, account, source and a masked cookie; exits 1 when signed out', async () => {
  const none = await olcli(['auth', 'status']);
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stdout, /Not signed in/);
  assert.match(none.stdout, /Run: olcli auth/);

  const live = await mockOverleaf({ loggedIn: true });
  try {
    const cookie = 'abcdefghijklmnopqrstuvwxyz-SECRET-wxyz';
    const result = await olcli(['auth', 'status'], { env: { OVERLEAF_SESSION: cookie, OVERLEAF_BASE_URL: live.baseUrl } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`Instance\\s+${live.baseUrl.replace(/[.]/g, '\\.')}`));
    assert.match(result.stdout, /Account\s+me@example\.com/);
    assert.match(result.stdout, /Credential\s+OVERLEAF_SESSION environment variable/);
    assert.match(result.stdout, /overleaf_session2 = \*\*\*\*wxyz \(38 chars\)/);
    assert.ok(!result.stdout.includes('abcdefghijklmnopqrst'), 'cookie must be masked');

    const json = await olcli(['auth', 'status', '--json'], { env: { OVERLEAF_SESSION: cookie, OVERLEAF_BASE_URL: live.baseUrl } });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.signedIn, true);
    assert.equal(parsed.account, 'me@example.com');
    assert.equal(parsed.projects, 1);

    const check = await olcli(['check'], { env: { OVERLEAF_SESSION: cookie, OVERLEAF_BASE_URL: live.baseUrl } });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stderr, /now 'olcli auth status'/);
  } finally {
    await live.close();
  }
});

function freshHome(): Record<string, string> {
  const dir = mkdtempSync(join(home, 'home-'));
  return { HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), APPDATA: join(dir, 'AppData') };
}

test('auth --cookie - reads stdin, warns about nothing, and prints the next steps', async () => {
  const live = await mockOverleaf({ loggedIn: true });
  try {
    const env = { ...freshHome(), OVERLEAF_BASE_URL: live.baseUrl };
    const result = await olcli(['auth', '--cookie', '-'], { input: 'overleaf_session2=from-stdin\n', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Authenticated! Found 1 projects/);
    assert.match(result.stdout, /Next steps:\s+olcli list\s+olcli pull "Paper"/);
    assert.doesNotMatch(result.stderr, /shell history/);

    const status = await olcli(['auth', 'status', '--json'], { env });
    assert.equal(JSON.parse(status.stdout).cookie, '**** (10 chars)');
  } finally {
    await live.close();
  }
});

test('auth --cookie <value> warns that the cookie is in the shell history', async () => {
  const live = await mockOverleaf({ loggedIn: true });
  try {
    const result = await olcli(['auth', '--cookie', 'in-argv-cookie'], { env: { ...freshHome(), OVERLEAF_BASE_URL: live.baseUrl } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Warning: the cookie is now in your shell history/);
    assert.match(result.stdout, /olcli pull "Paper"/);
  } finally {
    await live.close();
  }
});

test('auth --cookie without a value prompts, and without a terminal says how to pipe it', async () => {
  const result = await olcli(['auth', '--cookie'], { env: freshHome() });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /No terminal available to prompt for the cookie/);
  assert.match(result.stderr, /olcli auth --cookie -/);
});

test('no error or hint suggests --password on the command line', async () => {
  const none = await olcli(['list'], { env: freshHome() });
  assert.equal(none.status, 1);
  assert.doesNotMatch(none.stdout + none.stderr, /--password/);
  assert.match(none.stderr, /olcli auth --cookie/);
  for (const file of ['cli.ts', 'mcp.ts', 'mcp-server.ts', 'remote-helper.ts']) {
    const text = readFileSync(join(SRC, file), 'utf-8');
    const offenders = text.split('\n').filter((line) => /--password <|--password \$\{|--password \*/.test(line) && !/\.option\(/.test(line));
    assert.deepEqual(offenders, [], file);
  }
});

test('info finds a project case-insensitively and suggests names on a miss', async () => {
  const live = await mockOverleaf({ loggedIn: true });
  try {
    const miss = await olcli(['info', 'Papr'], { env: sessionEnv(live) });
    assert.equal(miss.status, 1, miss.stdout + miss.stderr);
    assert.match(miss.stdout + miss.stderr, /Project not found: Papr/);
    assert.match(miss.stdout + miss.stderr, /Did you mean: "Paper"/);

    const pulled = await olcli(['pull', 'paper', join(home, 'pulled-lower')], { env: sessionEnv(live) });
    assert.equal(pulled.status, 0, pulled.stdout + pulled.stderr);
  } finally {
    await live.close();
  }
});

test('pull keeps non-ASCII letters in the directory name and reuses a pre-0.16 directory', async () => {
  const live = await mockOverleaf({ loggedIn: true, projectName: 'Masterarbeit Müller', files: { 'main.tex': 'x\n' } });
  try {
    const fresh = mkdtempSync(join(home, 'unicode-'));
    const result = await olcli(['pull', 'Masterarbeit Müller'], { cwd: fresh, env: sessionEnv(live) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(fresh, 'Masterarbeit_Müller', 'main.tex')), 'expected Masterarbeit_Müller/');

    // A directory an earlier olcli created for the same project keeps working.
    const old = mkdtempSync(join(home, 'legacy-'));
    mkdirSync(join(old, 'Masterarbeit_M_ller'));
    writeFileSync(join(old, 'Masterarbeit_M_ller', '.olcli.json'), JSON.stringify({ projectId: PROJECT_ID, projectName: 'Masterarbeit Müller' }));
    const again = await olcli(['pull', 'Masterarbeit Müller'], { cwd: old, env: sessionEnv(live) });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.ok(existsSync(join(old, 'Masterarbeit_M_ller', 'main.tex')), 'expected the legacy directory to be reused');
    assert.ok(!existsSync(join(old, 'Masterarbeit_Müller')), 'must not create a second copy');
  } finally {
    await live.close();
  }
});
