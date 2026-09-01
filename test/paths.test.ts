import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { resolveWithin } from '../src/paths.js';

const base = resolve('/tmp/project');

test('resolveWithin: accepts plain relative paths', () => {
  assert.equal(resolveWithin(base, 'main.tex'), resolve(base, 'main.tex'));
  assert.equal(resolveWithin(base, 'figures/diagram.png'), resolve(base, 'figures/diagram.png'));
});

test('resolveWithin: accepts paths with harmless dot segments', () => {
  assert.equal(resolveWithin(base, './chapters/../main.tex'), resolve(base, 'main.tex'));
});

test('resolveWithin: rejects traversal that escapes the base directory', () => {
  assert.equal(resolveWithin(base, '../evil.sh'), null);
  assert.equal(resolveWithin(base, '../../etc/passwd'), null);
  assert.equal(resolveWithin(base, 'a/../../evil.sh'), null);
});

test('resolveWithin: rejects absolute paths', () => {
  assert.equal(resolveWithin(base, '/etc/passwd'), null);
});

test('resolveWithin: rejects the base directory itself', () => {
  assert.equal(resolveWithin(base, '.'), null);
  assert.equal(resolveWithin(base, 'a/..'), null);
});

test('resolveWithin: does not allow sibling-prefix escapes', () => {
  // /tmp/project-evil starts with /tmp/project as a string, but is outside
  assert.equal(resolveWithin(base, `..${sep}project-evil${sep}x`), null);
});
