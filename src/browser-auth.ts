/**
 * `olcli auth --browser`: sign in through a real browser window and keep only
 * the session cookie.
 *
 * Copying a cookie out of the developer tools is the hardest step of the first
 * run, and SSO, ORCID, Google and two-factor logins have no other path. So
 * olcli starts the installed Chrome, Edge, Chromium or Brave with a fresh
 * temporary profile (never the user's own), opens the instance's login page,
 * and watches the cookie jar of that profile over the Chrome DevTools Protocol
 * until a session cookie appears that Overleaf accepts for the project list.
 *
 * What olcli sees: only the cookies the browser would send to the instance
 * URL, and of those only the session cookie is kept. It never sees a form
 * field or a password; the user types those into the browser, not into olcli.
 *
 * No dependency: the protocol is JSON over a WebSocket, and Node 22 ships a
 * WebSocket client. The browser process and its profile directory are removed
 * on success, error, timeout and Ctrl-C.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

/** How long `auth --browser` waits for the user to finish signing in. */
export const BROWSER_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** Session cookie names olcli knows, in addition to the configured one. */
export const KNOWN_SESSION_COOKIES = ['overleaf_session2', 'overleaf.sid'];

// ─────────────────────────────────────────────────────────────────────────────
// Finding a browser
// ─────────────────────────────────────────────────────────────────────────────

export class BrowserNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserNotFoundError';
  }
}

export interface BrowserLookup {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** True when `path` is an existing file (or, for an .app, directory). */
  exists?: (path: string) => boolean;
  /** Contents of a text file, or undefined. Used for Info.plist. */
  readText?: (path: string) => string | undefined;
}

export interface FoundBrowser {
  /** The executable to start. */
  path: string;
  /** A name for messages, like "Google Chrome". */
  name: string;
}

const MAC_APPS = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'];
const LINUX_BINARIES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
const WINDOWS_BINARIES: [string, string][] = [
  ['Google\\Chrome\\Application\\chrome.exe', 'Google Chrome'],
  ['Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge'],
  ['Chromium\\Application\\chrome.exe', 'Chromium'],
  ['BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Brave'],
];

function defaultExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function defaultReadText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * The executable inside a macOS .app bundle: CFBundleExecutable from
 * Info.plist when it is readable as XML, else the bundle name without ".app".
 */
export function appBundleExecutable(appPath: string, readText: (path: string) => string | undefined = defaultReadText): string {
  const app = appPath.replace(/\/+$/, '');
  const plist = readText(join(app, 'Contents', 'Info.plist'));
  const declared = plist?.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  return join(app, 'Contents', 'MacOS', declared ?? basename(app).replace(/\.app$/i, ''));
}

const NOT_FOUND_HINT = 'Set OLCLI_BROWSER to the browser (an .app bundle or the executable), or sign in with the session cookie instead: olcli auth --cookie';

/**
 * The browser to start. OLCLI_BROWSER first (an executable, or on macOS an
 * .app bundle), then the usual install locations of Chrome, Chromium, Edge
 * and Brave for the platform.
 */
export function findBrowser(lookup: BrowserLookup = {}): FoundBrowser {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const home = lookup.home ?? homedir();
  const exists = lookup.exists ?? defaultExists;
  const readText = lookup.readText ?? defaultReadText;

  const override = env.OLCLI_BROWSER?.trim();
  if (override) {
    const path = /\.app\/?$/i.test(override) ? appBundleExecutable(override, readText) : override;
    if (!exists(path)) {
      throw new BrowserNotFoundError(`OLCLI_BROWSER is set to ${override}, but ${path} does not exist. ${NOT_FOUND_HINT}`);
    }
    return { path, name: basename(path).replace(/\.exe$/i, '') };
  }

  if (platform === 'darwin') {
    for (const dir of ['/Applications', join(home, 'Applications')]) {
      for (const app of MAC_APPS) {
        const bundle = join(dir, `${app}.app`);
        if (!exists(bundle)) continue;
        const path = appBundleExecutable(bundle, readText);
        if (exists(path)) return { path, name: app };
      }
    }
  } else if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    for (const [relative, name] of WINDOWS_BINARIES) {
      for (const root of roots) {
        const path = `${root.replace(/\\+$/, '')}\\${relative}`;
        if (exists(path)) return { path, name };
      }
    }
  } else {
    const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const binary of LINUX_BINARIES) {
      for (const dir of dirs) {
        const path = join(dir, binary);
        if (exists(path)) return { path, name: binary };
      }
    }
  }

  throw new BrowserNotFoundError(`No Chrome, Edge, Chromium or Brave found. ${NOT_FOUND_HINT}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Picking the session cookie
// ─────────────────────────────────────────────────────────────────────────────

/** The fields of a CDP Network.Cookie that matter here. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
}

export interface SessionCookie {
  name: string;
  value: string;
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  const target = host.replace(/^\[|\]$/g, '').toLowerCase();
  return target === domain || target.endsWith(`.${domain}`);
}

/**
 * The session cookie among `cookies`, or undefined. Only a cookie for the
 * instance's host whose name is the configured one or one of the known
 * session cookie names is taken; everything else is ignored, so no other
 * cookie ever leaves this function. The configured name wins over the others.
 */
export function pickSessionCookie(cookies: BrowserCookie[], baseUrl: string, preferredName: string): SessionCookie | undefined {
  const host = new URL(baseUrl).hostname;
  const names = [preferredName, ...KNOWN_SESSION_COOKIES.filter((n) => n !== preferredName)];
  for (const name of names) {
    const match = cookies.find((c) => c.name === name && c.value && domainMatches(c.domain, host));
    if (match) return { name: match.name, value: match.value };
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Talking to the browser
// ─────────────────────────────────────────────────────────────────────────────

/** The part of the DevTools Protocol olcli uses. Faked in tests. */
export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): void;
}

/** A started browser: its protocol connection and how to stop it. */
export interface RunningBrowser {
  cdp: CdpTransport;
  /** Resolves when the browser process exits, for whatever reason. */
  exited: Promise<void>;
  /** Close the browser; kills it if it does not exit by itself. */
  stop(): Promise<void>;
}

export type StartBrowser = (profileDir: string, url: string, signal: AbortSignal) => Promise<RunningBrowser>;

export class BrowserSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSignInError';
  }
}

export class BrowserSignInAborted extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'BrowserSignInAborted';
  }
}

/** Node's WebSocket, or a clear error on Node 20 and 21, which do not ship one. */
export function requireWebSocket(): typeof WebSocket {
  const ws = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!ws) {
    throw new BrowserSignInError(`Browser sign-in needs Node 22 or newer (this is Node ${process.versions.node}). Upgrade Node, or sign in with: olcli auth --cookie`);
  }
  return ws;
}

/** A CdpTransport over a WebSocket to the browser endpoint. */
export async function connectCdp(endpoint: string): Promise<CdpTransport> {
  const Ws = requireWebSocket();
  const socket = new Ws(endpoint);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new BrowserSignInError(`Could not connect to the browser at ${endpoint}.`)), { once: true });
  });

  const failAll = (error: Error): void => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  socket.addEventListener('message', (event: MessageEvent) => {
    let message: any;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new BrowserSignInError(`Browser protocol error: ${message.error.message ?? 'unknown'}`));
    else waiter.resolve(message.result);
  });
  socket.addEventListener('close', () => failAll(new BrowserSignInError('The browser closed the connection.')));

  return {
    send(method, params = {}, sessionId) {
      if (socket.readyState !== socket.OPEN) return Promise.reject(new BrowserSignInError('The browser closed the connection.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** Command-line arguments for a throwaway browser session. */
export function browserArgs(profileDir: string, url: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    // A throwaway profile needs no OS secret store: without these, macOS may
    // ask for the keychain and Linux for the keyring before the page loads.
    '--use-mock-keychain',
    '--password-store=basic',
    '--new-window',
    url,
  ];
}

/**
 * `promise`, but rejected with BrowserSignInAborted when `signal` fires and
 * with a BrowserSignInError after `ms`. A protocol call to a busy or hung
 * browser can stay unanswered; without this, Ctrl-C would wait for it.
 */
export function guarded<T>(promise: Promise<T>, signal: AbortSignal, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new BrowserSignInAborted());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BrowserSignInAborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      reject(new BrowserSignInError(`The browser did not answer (${what}) within ${Math.round(ms / 1000)} seconds.`));
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * The real StartBrowser: spawn `executable`, wait for it to write
 * DevToolsActivePort into the profile, then connect to the browser endpoint.
 * `--remote-debugging-port=0` lets the browser pick a free port.
 */
export function chromiumLauncher(executable: string): StartBrowser {
  return async (profileDir, url, signal) => {
    requireWebSocket();
    const child: ChildProcess = spawn(executable, browserArgs(profileDir, url), { stdio: 'ignore', detached: false });
    let exitedFlag = false;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => { exitedFlag = true; resolve(); });
      child.once('error', () => { exitedFlag = true; resolve(); });
    });

    const kill = async (): Promise<void> => {
      if (exitedFlag) return;
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(3000)]);
      if (!exitedFlag) {
        child.kill('SIGKILL');
        await Promise.race([exited, sleep(2000)]);
      }
    };

    try {
      const portFile = join(profileDir, 'DevToolsActivePort');
      const deadline = Date.now() + 30_000;
      let endpoint: string | undefined;
      while (!endpoint) {
        if (signal.aborted) throw new BrowserSignInAborted();
        if (exitedFlag) throw new BrowserSignInError(`The browser (${executable}) exited before it was ready.`);
        if (Date.now() > deadline) throw new BrowserSignInError('The browser did not open its DevTools port within 30 seconds.');
        const content = existsSync(portFile) ? readFileSync(portFile, 'utf-8').split('\n') : [];
        if (content.length >= 2 && /^\d+$/.test(content[0].trim()) && content[1].trim().startsWith('/')) {
          endpoint = `ws://127.0.0.1:${content[0].trim()}${content[1].trim()}`;
        } else {
          await sleep(100, signal);
        }
      }
      const cdp = await connectCdp(endpoint);
      return {
        cdp,
        exited,
        async stop() {
          if (!exitedFlag) {
            await Promise.race([cdp.send('Browser.close').catch(() => undefined), sleep(2000)]);
            await Promise.race([exited, sleep(3000)]);
          }
          cdp.close();
          await kill();
        },
      };
    } catch (error) {
      await kill();
      throw error;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The sign-in loop
// ─────────────────────────────────────────────────────────────────────────────

export interface BrowserSignInOptions {
  baseUrl: string;
  /** The configured session cookie name. */
  cookieName: string;
  startBrowser: StartBrowser;
  /**
   * True when Overleaf accepts the cookie for the project list. Errors count
   * as "not yet": before the login, the instance already sets an anonymous
   * session cookie under the same name.
   */
  validate: (cookie: SessionCookie) => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Where the temporary profile goes; os.tmpdir() by default. */
  tmpRoot?: string;
  /** Called with the profile directory once it exists. */
  onProfile?: (profileDir: string) => void;
}

/**
 * Open `<baseUrl>/login` in a throwaway browser profile and wait until the
 * profile holds a session cookie that `validate` accepts. Returns that cookie
 * only. The browser is closed and the profile deleted on every way out.
 */
export async function browserSignIn(options: BrowserSignInOptions): Promise<SessionCookie> {
  const timeoutMs = options.timeoutMs ?? BROWSER_SIGN_IN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 1000;
  const base = options.baseUrl.replace(/\/+$/, '');
  const profileDir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'olcli-browser-'));
  options.onProfile?.(profileDir);

  const local = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
  let browser: RunningBrowser | undefined;
  let closedByUser = false;

  try {
    if (signal.aborted) throw new BrowserSignInAborted();
    browser = await options.startBrowser(profileDir, `${base}/login`, signal);
    browser.exited.then(() => { closedByUser = true; local.abort(); });

    // Network.getCookies with a URL filter returns only the cookies the
    // browser would send to the instance, so olcli never receives the cookies
    // of an SSO provider. It needs a page session, hence the attach.
    const cdp = browser.cdp;
    const call = (method: string, params?: Record<string, unknown>, session?: string): Promise<any> =>
      guarded(cdp.send(method, params, session), signal, 15_000, method);
    const attach = async (): Promise<string | undefined> => {
      const { targetInfos } = await call('Target.getTargets');
      const page = (targetInfos as { targetId: string; type: string }[]).find((t) => t.type === 'page');
      if (!page) return undefined;
      const { sessionId } = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      return sessionId as string;
    };
    let sessionId = await attach();
    if (!sessionId) throw new BrowserSignInError('The browser opened no page to sign in on.');

    const deadline = Date.now() + timeoutMs;
    let lastTried: string | undefined;
    let lastTriedAt = 0;
    while (Date.now() < deadline) {
      if (signal.aborted) break;
      let cookies: BrowserCookie[] = [];
      try {
        const result = await call('Network.getCookies', { urls: [`${base}/`] }, sessionId);
        cookies = (result?.cookies ?? []) as BrowserCookie[];
      } catch {
        if (signal.aborted) break;
        // The tab olcli attached to was closed: move to another one, and
        // give up only when the user closed every window.
        sessionId = await attach().catch(() => undefined);
        if (signal.aborted) break;
        if (!sessionId) {
          throw new BrowserSignInError('The browser window was closed before the sign-in finished. Run olcli auth --browser again.');
        }
        continue;
      }
      const candidate = pickSessionCookie(cookies, base, options.cookieName);
      // Re-check the same value now and then: Overleaf may keep the session
      // id across the login and only mark the session as logged in.
      if (candidate && (candidate.value !== lastTried || Date.now() - lastTriedAt >= 3000)) {
        lastTried = candidate.value;
        lastTriedAt = Date.now();
        let valid = false;
        try {
          valid = await guarded(options.validate(candidate), signal, 60_000, 'validation');
        } catch {
          valid = false;
        }
        if (valid) return candidate;
      }
      await sleep(pollMs, signal);
    }

    if (closedByUser && !options.signal?.aborted) {
      throw new BrowserSignInError('The browser was closed before the sign-in finished. Run olcli auth --browser again.');
    }
    if (signal.aborted) throw new BrowserSignInAborted();
    throw new BrowserSignInError(`No sign-in within ${Math.round(timeoutMs / 1000)} seconds. Run olcli auth --browser again, or use olcli auth --cookie.`);
  } finally {
    if (browser) await browser.stop().catch(() => undefined);
    removeProfile(profileDir);
  }
}

/** Delete a temporary profile. Retries, since the browser may still be writing. */
export function removeProfile(profileDir: string): void {
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Last resort; the OS cleans its temp directory eventually.
  }
}
