import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_FALLBACK_QUESTION,
  canOfferBrowserSignIn,
  offerBrowserSignIn,
  passwordSignInWarnings,
  type BrowserFallbackDeps,
} from '../src/auth-fallback.js';
import { CaptchaRequiredError, HttpStatusError, formatError, formatErrorText } from '../src/errors.js';
import { parseYesNo } from '../src/prompt.js';

function deps(overrides: Partial<BrowserFallbackDeps> & { answer?: boolean } = {}) {
  const calls = { asked: [] as string[], browser: 0 };
  const d: BrowserFallbackDeps = {
    interactive: true,
    checkBrowser: () => {},
    ask: async (question) => { calls.asked.push(question); return overrides.answer ?? true; },
    runBrowser: async () => { calls.browser += 1; },
    ...overrides,
  };
  return { d, calls };
}

const captcha = new CaptchaRequiredError('www.overleaf.com', 400);

test('browser fallback: interactive and yes runs the browser sign-in', async () => {
  const { d, calls } = deps({ answer: true });
  assert.deepEqual(await offerBrowserSignIn(captcha, d), { outcome: 'browser' });
  assert.deepEqual(calls.asked, [BROWSER_FALLBACK_QUESTION]);
  assert.equal(calls.browser, 1);
});

test('browser fallback: no leaves it at the message', async () => {
  const { d, calls } = deps({ answer: false });
  assert.deepEqual(await offerBrowserSignIn(captcha, d), { outcome: 'declined' });
  assert.equal(calls.browser, 0);
});

test('browser fallback: never asks when not interactive', async () => {
  const { d, calls } = deps({ interactive: false });
  assert.deepEqual(await offerBrowserSignIn(captcha, d), { outcome: 'not-offered' });
  assert.deepEqual(calls.asked, []);
  assert.equal(calls.browser, 0);
});

test('browser fallback: other errors are not answered with a browser offer', async () => {
  const { d, calls } = deps();
  assert.deepEqual(await offerBrowserSignIn(new HttpStatusError('Password login failed', 400), d), { outcome: 'not-offered' });
  assert.deepEqual(await offerBrowserSignIn(new Error('Password login failed. Email or password may be incorrect.'), d), { outcome: 'not-offered' });
  assert.deepEqual(calls.asked, []);
});

test('browser fallback: no browser or old Node means no question, only the reason', async () => {
  const { d, calls } = deps({ checkBrowser: () => { throw new Error('No Chrome, Edge, Chromium or Brave found.'); } });
  assert.deepEqual(await offerBrowserSignIn(captcha, d), { outcome: 'unavailable', reason: 'No Chrome, Edge, Chromium or Brave found.' });
  assert.deepEqual(calls.asked, []);
  assert.equal(calls.browser, 0);
});

test('canOfferBrowserSignIn: needs a TTY on stdin and stdout and no CI', () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(canOfferBrowserSignIn({ stdin: tty, stdout: tty }, {}), true);
  assert.equal(canOfferBrowserSignIn({ stdin: pipe, stdout: tty }, {}), false);
  assert.equal(canOfferBrowserSignIn({ stdin: tty, stdout: pipe }, {}), false);
  assert.equal(canOfferBrowserSignIn({ stdin: tty, stdout: tty }, { CI: 'true' }), false);
  assert.equal(canOfferBrowserSignIn({ stdin: tty, stdout: tty }, { CI: '1' }), false);
  assert.equal(canOfferBrowserSignIn({ stdin: tty, stdout: tty }, { CI: 'false' }), true);
});

test('parseYesNo: empty takes the default, only y/yes is yes', () => {
  assert.equal(parseYesNo('', true), true);
  assert.equal(parseYesNo('  ', false), false);
  assert.equal(parseYesNo('Y', false), true);
  assert.equal(parseYesNo('yes', false), true);
  assert.equal(parseYesNo('n', true), false);
  assert.equal(parseYesNo('nope', true), false);
  assert.equal(parseYesNo('x', true), false);
});

test('auth status warning: password credentials on overleaf.com warn, self-hosted does not', () => {
  for (const url of ['https://www.overleaf.com', 'https://www.overleaf.com/', 'https://overleaf.com']) {
    const warnings = passwordSignInWarnings(true, url);
    assert.equal(warnings.length, 1, url);
    assert.match(warnings[0], /overleaf\.com requires a captcha for password sign-in/);
    assert.match(warnings[0], /olcli auth --browser/);
  }
  assert.deepEqual(passwordSignInWarnings(true, 'https://latex.example.org'), []);
  assert.deepEqual(passwordSignInWarnings(true, 'http://127.0.0.1:8080'), []);
  assert.deepEqual(passwordSignInWarnings(false, 'https://www.overleaf.com'), []);
  assert.deepEqual(passwordSignInWarnings(true, 'not a url'), []);
});

test('CaptchaRequiredError: one message for CLI, MCP and the remote helper', () => {
  const lines = formatError(captcha);
  assert.equal(lines[0], 'www.overleaf.com requires a captcha for password sign-in, which olcli cannot complete. Sign in with `olcli auth --browser`, or paste a session cookie with `olcli auth --cookie`.');
  assert.equal(lines[1], 'Overleaf answered HTTP 400.');
  assert.doesNotMatch(lines.join('\n'), /--verbose/, 'the request log would not explain more');
  assert.equal(formatErrorText(captcha, { verbose: true }), lines.join('\n'));
  assert.deepEqual(formatError(new CaptchaRequiredError('latex.example.org')), [new CaptchaRequiredError('latex.example.org').message]);
});
