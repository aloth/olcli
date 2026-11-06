import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { resolveWithin, safeLocalName, legacyLocalName } from '../src/paths.js';

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

test('safeLocalName keeps letters from any script and emoji', () => {
  assert.equal(safeLocalName('Masterarbeit Müller'), 'Masterarbeit_Müller');
  assert.equal(safeLocalName('机器学习论文'), '机器学习论文');
  assert.equal(safeLocalName('Paper 📄 draft'), 'Paper_📄_draft');
  assert.equal(safeLocalName('Ελληνικά-ε'), 'Ελληνικά-ε');
});

test('safeLocalName keeps ASCII names as before', () => {
  for (const name of ['My Paper', 'thesis-2026_v2', 'Grant Proposal 2026']) {
    assert.equal(safeLocalName(name), legacyLocalName(name));
  }
});

test('safeLocalName replaces only path-unsafe characters', () => {
  assert.equal(safeLocalName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeLocalName('tab\there\u0001'), 'tab_here_');
  assert.equal(safeLocalName('..hidden'), 'hidden');
  assert.equal(safeLocalName('trailing. '), 'trailing');
  assert.equal(safeLocalName('CON'), 'CON_');
  assert.equal(safeLocalName('...'), 'project');
  assert.equal(safeLocalName('../../etc'), '_.._etc');
});

test('safeLocalName caps the name at 200 bytes without splitting a character', () => {
  const name = safeLocalName('ü'.repeat(150));
  assert.ok(Buffer.byteLength(name) <= 200);
  assert.equal(name, 'ü'.repeat(100));
  assert.equal(safeLocalName('論'.repeat(100)).length, 66);
});

test('NFD input is normalized so the name matches what the user sees', () => {
  assert.equal(safeLocalName('Mu\u0308ller'), 'Müller');
});
