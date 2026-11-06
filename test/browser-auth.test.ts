import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appBundleExecutable,
  browserArgs,
  browserSignIn,
  BrowserNotFoundError,
  BrowserSignInAborted,
  BrowserSignInError,
  findBrowser,
  pickSessionCookie,
  type BrowserCookie,
  type CdpTransport,
  type RunningBrowser,
  type StartBrowser,
} from '../src/browser-auth.js';

// No real browser and no network here: the DevTools transport is faked, and
// the CLI tests run the entry point with an empty HOME.

const PLIST = `<?xml version="1.0"?><plist><dict>
<key>CFBundleExecutable</key>
<string>Google Chrome</string>
</dict></plist>`;

test('OLCLI_BROWSER accepts an .app bundle and resolves Contents/MacOS/<executable>', () => {
  const app = '/Volumes/Apps/Google Chrome.app';
  const binary = `${app}/Contents/MacOS/Google Chrome`;
  const found = findBrowser({
    env: { OLCLI_BROWSER: `${app}/` },
    platform: 'darwin',
    exists: (p) => p === binary,
    readText: (p) => (p === `${app}/Contents/Info.plist` ? PLIST : undefined),
  });
  assert.equal(found.path, binary);
  assert.equal(found.name, 'Google Chrome');

  // Without a readable Info.plist the bundle name is used.
  assert.equal(appBundleExecutable('/x/Brave Browser.app', () => undefined), '/x/Brave Browser.app/Contents/MacOS/Brave Browser');
});

test('OLCLI_BROWSER accepts an executable and wins over installed browsers', () => {
  const found = findBrowser({
    env: { OLCLI_BROWSER: '/opt/chromium/chrome', PATH: '/usr/bin' },
    platform: 'linux',
    exists: (p) => p === '/opt/chromium/chrome' || p === '/usr/bin/google-chrome',
  });
  assert.equal(found.path, '/opt/chromium/chrome');
});

test('an OLCLI_BROWSER that does not exist names the variable and the cookie path', () => {
  assert.throws(
    () => findBrowser({ env: { OLCLI_BROWSER: '/nowhere/Chrome.app' }, platform: 'darwin', exists: () => false, readText: () => undefined }),
    (error: Error) => error instanceof BrowserNotFoundError && /OLCLI_BROWSER/.test(error.message) && /olcli auth --cookie/.test(error.message),
  );
});

test('the usual install locations are searched per platform', () => {
  const mac = findBrowser({
    env: {},
    platform: 'darwin',
    home: '/Users/me',
    exists: (p) => p.startsWith('/Users/me/Applications/Microsoft Edge.app'),
    readText: () => undefined,
  });
  assert.equal(mac.path, '/Users/me/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');

  const linux = findBrowser({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', exists: (p) => p === '/usr/bin/chromium-browser' });
  assert.equal(linux.path, '/usr/bin/chromium-browser');

  const windows = findBrowser({
    env: { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' },
    platform: 'win32',
    exists: (p) => p === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  });
  assert.equal(windows.name, 'Microsoft Edge');
});

test('no browser found: the error names OLCLI_BROWSER and olcli auth --cookie', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.throws(
      () => findBrowser({ env: { PATH: '/usr/bin' }, platform, home: '/h', exists: () => false, readText: () => undefined }),
      (error: Error) => error instanceof BrowserNotFoundError && /OLCLI_BROWSER/.test(error.message) && /olcli auth --cookie/.test(error.message),
    );
  }
});

test('only the session cookie for the instance host is picked; everything else is ignored', () => {
  const cookies: BrowserCookie[] = [
    { name: 'GCLB', value: 'lb', domain: 'www.overleaf.com' },
    { name: 'overleaf_session2', value: 'sso-provider', domain: 'login.example.edu' },
    { name: '_ga', value: 'tracking', domain: '.overleaf.com' },
    { name: 'overleaf_session2', value: 'the-session', domain: '.overleaf.com' },
  ];
  assert.deepEqual(pickSessionCookie(cookies, 'https://www.overleaf.com', 'overleaf_session2'), { name: 'overleaf_session2', value: 'the-session' });
  assert.equal(pickSessionCookie(cookies.slice(0, 3), 'https://www.overleaf.com', 'overleaf_session2'), undefined);

  // The configured name first, then the known names (older self-hosted instances).
  const selfHosted: BrowserCookie[] = [
    { name: 'overleaf.sid', value: 'old', domain: 'latex.example.org' },
    { name: 'custom_sid', value: 'custom', domain: 'latex.example.org' },
  ];
  assert.deepEqual(pickSessionCookie(selfHosted, 'https://latex.example.org', 'overleaf_session2'), { name: 'overleaf.sid', value: 'old' });
  assert.deepEqual(pickSessionCookie(selfHosted, 'https://latex.example.org', 'custom_sid'), { name: 'custom_sid', value: 'custom' });
  assert.equal(pickSessionCookie([{ name: 'overleaf_session2', value: '', domain: 'www.overleaf.com' }], 'https://www.overleaf.com', 'overleaf_session2'), undefined);
});

test('the browser starts with a temporary profile, a random DevTools port and the login page', () => {
  const args = browserArgs('/tmp/olcli-browser-x', 'https://www.overleaf.com/login');
  assert.ok(args.includes('--user-data-dir=/tmp/olcli-browser-x'));
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--no-default-browser-check'));
  assert.equal(args.at(-1), 'https://www.overleaf.com/login');
});

interface FakeBrowser {
  start: StartBrowser;
  calls: string[];
  stopped: () => boolean;
  openedUrl: () => string | undefined;
}

/** A fake browser whose cookie jar returns `jars` one after the other (the last one repeats). */
function fakeBrowser(jars: BrowserCookie[][], options: { exitAfterPolls?: number } = {}): FakeBrowser {
  const calls: string[] = [];
  let stopped = false;
  let url: string | undefined;
  let polls = 0;
  let exit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const cdp: CdpTransport = {
    async send(method, params) {
      calls.push(method);
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'T1', type: 'page' }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
      if (method === 'Network.getCookies') {
        assert.deepEqual(params, { urls: ['https://www.overleaf.com/'] });
        polls++;
        if (options.exitAfterPolls !== undefined && polls > options.exitAfterPolls) {
          exit();
          throw new Error('target closed');
        }
        return { cookies: jars[Math.min(polls - 1, jars.length - 1)] };
      }
      throw new Error(`unexpected ${method}`);
    },
    close() {},
  };
  return {
    calls,
    stopped: () => stopped,
    openedUrl: () => url,
    start: async (profileDir, openUrl): Promise<RunningBrowser> => {
      assert.ok(existsSync(profileDir), 'the profile exists while the browser runs');
      url = openUrl;
      return { cdp, exited, stop: async () => { stopped = true; exit(); } };
    },
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'olcli-browser-test-'));
}

test('sign-in returns the validated session cookie, closes the browser and deletes the profile', async () => {
  const root = scratch();
  try {
    const anonymous = { name: 'overleaf_session2', value: 'anonymous', domain: '.overleaf.com' };
    const loggedIn = { name: 'overleaf_session2', value: 'logged-in', domain: '.overleaf.com' };
    const other = { name: 'oa', value: 'x', domain: '.overleaf.com' };
    const browser = fakeBrowser([[], [anonymous, other], [loggedIn, other]]);
    const validated: string[] = [];
    let profile = '';
    const result = await browserSignIn({
      baseUrl: 'https://www.overleaf.com/',
      cookieName: 'overleaf_session2',
      startBrowser: browser.start,
      validate: async (cookie) => { validated.push(cookie.value); return cookie.value === 'logged-in'; },
      pollMs: 1,
      tmpRoot: root,
      onProfile: (dir) => { profile = dir; },
    });
    assert.deepEqual(result, { name: 'overleaf_session2', value: 'logged-in' });
    assert.deepEqual(validated, ['anonymous', 'logged-in']);
    assert.equal(browser.openedUrl(), 'https://www.overleaf.com/login');
    assert.ok(browser.stopped());
    assert.ok(profile.startsWith(root));
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a validation error counts as not signed in yet', async () => {
  const root = scratch();
  try {
    const browser = fakeBrowser([[{ name: 'overleaf_session2', value: 'v', domain: 'www.overleaf.com' }]]);
    let attempts = 0;
    await assert.rejects(browserSignIn({
      baseUrl: 'https://www.overleaf.com',
      cookieName: 'overleaf_session2',
      startBrowser: browser.start,
      validate: async () => { attempts++; throw new Error('login page'); },
      pollMs: 1,
      timeoutMs: 50,
      tmpRoot: root,
    }), BrowserSignInError);
    assert.ok(attempts >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout: the error says what to run, the browser is closed and the profile deleted', async () => {
  const root = scratch();
  try {
    const browser = fakeBrowser([[]]);
    let profile = '';
    await assert.rejects(
      browserSignIn({ baseUrl: 'https://www.overleaf.com', cookieName: 'overleaf_session2', startBrowser: browser.start, validate: async () => true, pollMs: 1, timeoutMs: 30, tmpRoot: root, onProfile: (d) => { profile = d; } }),
      (error: Error) => error instanceof BrowserSignInError && /olcli auth --browser/.test(error.message),
    );
    assert.ok(browser.stopped());
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('abort (Ctrl-C): rejects with BrowserSignInAborted, closes the browser, deletes the profile', async () => {
  const root = scratch();
  try {
    const browser = fakeBrowser([[]]);
    const controller = new AbortController();
    let profile = '';
    const pending = browserSignIn({ baseUrl: 'https://www.overleaf.com', cookieName: 'overleaf_session2', startBrowser: browser.start, validate: async () => true, pollMs: 5, signal: controller.signal, tmpRoot: root, onProfile: (d) => { profile = d; } });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, BrowserSignInAborted);
    assert.ok(browser.stopped());
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('error while starting the browser: the profile is deleted all the same', async () => {
  const root = scratch();
  try {
    let profile = '';
    await assert.rejects(
      browserSignIn({ baseUrl: 'https://www.overleaf.com', cookieName: 'overleaf_session2', startBrowser: async () => { throw new BrowserSignInError('exited early'); }, validate: async () => true, tmpRoot: root, onProfile: (d) => { profile = d; } }),
      /exited early/,
    );
    assert.ok(profile);
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('closing the browser window ends the wait with a clear error and cleans up', async () => {
  const root = scratch();
  try {
    const browser = fakeBrowser([[]], { exitAfterPolls: 2 });
    let profile = '';
    await assert.rejects(
      browserSignIn({ baseUrl: 'https://www.overleaf.com', cookieName: 'overleaf_session2', startBrowser: browser.start, validate: async () => true, pollMs: 1, tmpRoot: root, onProfile: (d) => { profile = d; } }),
      (error: Error) => error instanceof BrowserSignInError && /closed before the sign-in finished/.test(error.message),
    );
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The CLI wiring, with an empty HOME and no browser anywhere.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

function olcli(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'olcli-browser-cli-'));
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('OVERLEAF_') && !key.startsWith('OLCLI_')) clean[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), CLI, ...args], {
      cwd: home,
      env: { ...clean, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData'), NODE_NO_WARNINGS: '1', NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf-8').on('data', (c: string) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
    child.stdin.end();
  });
}

test('--browser cannot be combined with --cookie, --email or --password', async () => {
  for (const extra of [['--cookie', 'abc'], ['--cookie'], ['--email', 'me@example.com'], ['--password', 'x']]) {
    const result = await olcli(['auth', '--browser', ...extra]);
    assert.equal(result.status, 1, extra.join(' '));
    assert.match(result.stderr, /Use either --browser or --cookie or --email\/--password/);
  }
});

test('--browser with a missing OLCLI_BROWSER names the variable and the cookie path', async () => {
  const result = await olcli(['auth', '--browser'], { OLCLI_BROWSER: '/nonexistent/olcli-test/Chrome.app' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OLCLI_BROWSER/);
  assert.match(result.stderr, /olcli auth --cookie/);
});

test('auth --help documents --browser and OLCLI_BROWSER', async () => {
  const result = await olcli(['auth', '--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--browser/);
  assert.match(result.stdout, /OLCLI_BROWSER/);
  assert.doesNotMatch(result.stdout, /\u2014/);
});

test('Ctrl-C ends the wait even when the browser never answers a protocol call', async () => {
  const root = scratch();
  try {
    let stopped = false;
    const hung: StartBrowser = async () => ({
      cdp: { send: () => new Promise(() => undefined), close() {} },
      exited: new Promise<void>(() => undefined),
      stop: async () => { stopped = true; },
    });
    const controller = new AbortController();
    let profile = '';
    const pending = browserSignIn({ baseUrl: 'https://www.overleaf.com', cookieName: 'overleaf_session2', startBrowser: hung, validate: async () => true, signal: controller.signal, tmpRoot: root, onProfile: (d) => { profile = d; } });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, BrowserSignInAborted);
    assert.ok(stopped);
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the throwaway profile does not touch the OS keychain', () => {
  const args = browserArgs('/tmp/p', 'https://www.overleaf.com/login');
  assert.ok(args.includes('--use-mock-keychain'));
  assert.ok(args.includes('--password-store=basic'));
});

test('an unchanged session cookie is re-validated only every recheckMs, a new value at once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olcli-recheck-'));
  try {
    const jar = (value: string): BrowserCookie[] => [{ name: 'overleaf_session2', value, domain: 'www.overleaf.com', path: '/' } as BrowserCookie];
    const browser = fakeBrowser([jar('anonymous'), jar('anonymous'), jar('anonymous'), jar('anonymous'), jar('anonymous'), jar('logged-in')]);
    const validated: string[] = [];
    const cookie = await browserSignIn({
      baseUrl: 'https://www.overleaf.com', cookieName: 'overleaf_session2', startBrowser: browser.start,
      validate: async (c) => { validated.push(c.value); return c.value === 'logged-in'; },
      pollMs: 1, recheckMs: 60_000, tmpRoot: root,
    });
    assert.equal(cookie.value, 'logged-in');
    assert.deepEqual(validated, ['anonymous', 'logged-in']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
