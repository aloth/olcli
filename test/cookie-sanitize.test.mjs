/**
 * Unit tests for cookie sanitization logic.
 *
 * Run with:  node --test test/cookie-sanitize.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
// Import the compiled modules (build must be up-to-date).
// ─────────────────────────────────────────────────────────────────────────────
import { OverleafClient } from '../dist/client.js';
import { getSessionCookie, getSessionCookieWithSource } from '../dist/config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: exercise getCookieHeader() via the public fromSessionCookie path by
// inspecting what the class stores.  We reach getCookieHeader indirectly by
// creating a minimal subclass-like wrapper that exposes the private method
// through prototype access.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal OverleafClient instance with the given cookies dict,
 * then invoke the private getCookieHeader() method and return the result.
 */
function buildCookieHeader(cookies) {
  // OverleafClient requires credentials.cookies / .csrf / (optional) .baseUrl
  const client = new OverleafClient({ cookies, csrf: 'test-csrf' });
  // Access private method via prototype (TypeScript compiles them as regular
  // JS properties on the prototype, so this is safe in tests).
  return OverleafClient.prototype['getCookieHeader'].call(client);
}

/**
 * Simulate applySetCookieHeaders() and return the resulting cookies dict.
 */
function applySetCookieHeaders(setCookieArray) {
  const client = new OverleafClient({ cookies: {}, csrf: 'test-csrf' });
  OverleafClient.prototype['applySetCookieHeaders'].call(client, setCookieArray);
  return client['cookies'];
}

// ─────────────────────────────────────────────────────────────────────────────
// getCookieHeader – control-character filtering
// ─────────────────────────────────────────────────────────────────────────────

test('getCookieHeader: clean cookie is included verbatim', () => {
  const header = buildCookieHeader({ overleaf_session2: 'abc123' });
  assert.equal(header, 'overleaf_session2=abc123');
});

test('getCookieHeader: cookie with \\n in value is excluded', () => {
  const cookies = {
    overleaf_session2: 'goodvalue',
    bad_cookie: 'val\nue',
  };
  const header = buildCookieHeader(cookies);
  assert.ok(header.includes('overleaf_session2=goodvalue'), 'clean cookie kept');
  assert.ok(!header.includes('bad_cookie'), 'cookie with \\n removed');
  assert.ok(!header.includes('\n'), 'no newline in header');
});

test('getCookieHeader: cookie with \\r in value is excluded', () => {
  const header = buildCookieHeader({ bad: 'val\rue' });
  assert.equal(header, '', 'cookie with \\r removed');
});

test('getCookieHeader: cookie with NUL byte is excluded', () => {
  const header = buildCookieHeader({ bad: 'val\x00ue' });
  assert.equal(header, '');
});

test('getCookieHeader: multiple cookies, only bad one excluded', () => {
  const cookies = {
    a: 'clean',
    b: 'also\x1Fbad',
    c: 'fine',
  };
  const header = buildCookieHeader(cookies);
  const parts = header.split('; ');
  assert.ok(parts.includes('a=clean'));
  assert.ok(parts.includes('c=fine'));
  assert.ok(!parts.some(p => p.startsWith('b=')), 'b excluded');
});

// ─────────────────────────────────────────────────────────────────────────────
// applySetCookieHeaders – control-character filtering
// ─────────────────────────────────────────────────────────────────────────────

test('applySetCookieHeaders: normal Set-Cookie is stored', () => {
  const cookies = applySetCookieHeaders(['overleaf_session2=abc123; Path=/']);
  assert.equal(cookies['overleaf_session2'], 'abc123');
});

test('applySetCookieHeaders: Set-Cookie with \\n in value is skipped', () => {
  const cookies = applySetCookieHeaders(['bad=val\nue; Path=/']);
  assert.equal(Object.keys(cookies).length, 0, 'cookie with \\n not stored');
});

test('applySetCookieHeaders: Set-Cookie with \\r in value is skipped', () => {
  const cookies = applySetCookieHeaders(['bad=val\rue; Path=/']);
  assert.equal(Object.keys(cookies).length, 0);
});

test('applySetCookieHeaders: clean and dirty Set-Cookie in same array', () => {
  const cookies = applySetCookieHeaders([
    'good=cleanval; Path=/',
    'bad=dirty\x01val; Path=/',
  ]);
  assert.equal(cookies['good'], 'cleanval', 'clean cookie stored');
  assert.equal(Object.keys(cookies).length, 1, 'dirty cookie not stored');
});

// ─────────────────────────────────────────────────────────────────────────────
// getSessionCookie – control-character stripping from env
// ─────────────────────────────────────────────────────────────────────────────

test('getSessionCookie: strips control chars from OVERLEAF_SESSION env var', () => {
  const original = process.env.OVERLEAF_SESSION;
  try {
    process.env.OVERLEAF_SESSION = 's%3Atest\nvalue\r';
    const cookie = getSessionCookie();
    assert.ok(cookie, 'cookie returned');
    assert.ok(!/[\x00-\x1F\x7F]/.test(cookie), 'no control chars in result');
    assert.equal(cookie, 's%3Atestvalue');
  } finally {
    if (original === undefined) {
      delete process.env.OVERLEAF_SESSION;
    } else {
      process.env.OVERLEAF_SESSION = original;
    }
  }
});

test('getSessionCookie: trims whitespace from OVERLEAF_SESSION env var', () => {
  const original = process.env.OVERLEAF_SESSION;
  try {
    process.env.OVERLEAF_SESSION = '  s%3Aclean  ';
    const cookie = getSessionCookie();
    assert.equal(cookie, 's%3Aclean');
  } finally {
    if (original === undefined) {
      delete process.env.OVERLEAF_SESSION;
    } else {
      process.env.OVERLEAF_SESSION = original;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// getSessionCookieWithSource – source tracking
// ─────────────────────────────────────────────────────────────────────────────

test('getSessionCookieWithSource: reports env as source', () => {
  const original = process.env.OVERLEAF_SESSION;
  try {
    process.env.OVERLEAF_SESSION = 's%3Atest';
    const info = getSessionCookieWithSource();
    assert.ok(info, 'info returned');
    assert.equal(info.source, 'env');
    assert.equal(info.value, 's%3Atest');
  } finally {
    if (original === undefined) {
      delete process.env.OVERLEAF_SESSION;
    } else {
      process.env.OVERLEAF_SESSION = original;
    }
  }
});
