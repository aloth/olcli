import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOlAuthPath, clearOlAuth, inspectStoredCredentials } from '../src/config.js';

// Every assertion here is scoped to a temp directory or to process.env.
//
// `config.ts` builds its Conf store against the real user config path at
// import time, so a test must never call clearConfig() or any setter: it would
// delete the credentials of whoever is running the suite. The functions under
// test all take an explicit directory for exactly that reason, and the two
// config-backed fields of inspectStoredCredentials() are left unasserted -
// their value depends on whether the machine happens to be logged in.

let root: string;
const savedEnv = {
  session: process.env.OVERLEAF_SESSION,
  email: process.env.OVERLEAF_EMAIL,
  password: process.env.OVERLEAF_PASSWORD
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'olcli-config-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  process.env.OVERLEAF_SESSION = savedEnv.session;
  process.env.OVERLEAF_EMAIL = savedEnv.email;
  process.env.OVERLEAF_PASSWORD = savedEnv.password;
});

beforeEach(() => {
  delete process.env.OVERLEAF_SESSION;
  delete process.env.OVERLEAF_EMAIL;
  delete process.env.OVERLEAF_PASSWORD;
});

test('getOlAuthPath: resolves .olauth inside the given directory', () => {
  assert.equal(getOlAuthPath(root), join(root, '.olauth'));
});

test('clearOlAuth: returns the removed path and deletes the file', () => {
  const authPath = join(root, '.olauth');
  writeFileSync(authPath, 'overleaf_session2=abc\n');

  assert.equal(clearOlAuth(root), authPath);
  assert.equal(existsSync(authPath), false, 'the file must actually be gone');
});

test('clearOlAuth: returns null when there is nothing to remove', () => {
  // logout distinguishes "cleared a file" from "there was no file" so it can
  // report what it actually did; a bare boolean would not carry the path.
  assert.equal(clearOlAuth(root), null);
});

test('inspectStoredCredentials: reports .olauth only while it exists', () => {
  const authPath = join(root, '.olauth');
  assert.equal(inspectStoredCredentials(root).olAuthPath, null);

  writeFileSync(authPath, 'overleaf_session2=abc\n');
  assert.equal(inspectStoredCredentials(root).olAuthPath, authPath);

  clearOlAuth(root);
  assert.equal(inspectStoredCredentials(root).olAuthPath, null);
});

test('inspectStoredCredentials: reports OVERLEAF_SESSION, which logout cannot unset', () => {
  assert.equal(inspectStoredCredentials(root).envSession, false);

  process.env.OVERLEAF_SESSION = 'from-the-environment';
  assert.equal(inspectStoredCredentials(root).envSession, true);
});

test('inspectStoredCredentials: needs both env password variables before reporting one', () => {
  // getPasswordCredentials() returns undefined unless both are set, so
  // reporting on either alone would announce a credential that cannot be used.
  process.env.OVERLEAF_EMAIL = 'someone@example.com';
  assert.equal(inspectStoredCredentials(root).envPassword, false);

  process.env.OVERLEAF_PASSWORD = 'secret';
  assert.equal(inspectStoredCredentials(root).envPassword, true);
});
