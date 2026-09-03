import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanLocalFiles } from '../src/scan.js';
import { loadIgnore } from '../src/ignore.js';

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'olcli-scan-'));
  mkdirSync(join(root, 'figures'), { recursive: true });
  mkdirSync(join(root, 'build'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });

  writeFileSync(join(root, 'main.tex'), '\\documentclass{article}\n');
  writeFileSync(join(root, 'main.aux'), 'aux artifact\n');
  writeFileSync(join(root, 'main.pdf'), 'compiled output\n');
  writeFileSync(join(root, 'figures', 'diagram.pdf'), 'hand-made figure\n');
  writeFileSync(join(root, 'build', 'ignored.tex'), 'in a build dir\n');
  writeFileSync(join(root, '.olcli.json'), '{}\n');
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const paths = (r: string) =>
  scanLocalFiles(r, loadIgnore(r)).files.map((f) => f.relativePath).sort();

test('scanLocalFiles: returns project-relative forward-slash paths', () => {
  assert.deepEqual(paths(root), ['figures/diagram.pdf', 'main.tex']);
});

test('scanLocalFiles: skips dotfiles and dot-directories without descending', () => {
  const found = paths(root);
  assert.ok(!found.includes('.olcli.json'), '.olcli.json must never be uploaded');
  assert.ok(!found.some((p) => p.startsWith('.git/')), '.git must not be walked');
});

test('scanLocalFiles: applies the default ignore list and the PDF sibling rule', () => {
  const found = paths(root);
  assert.ok(!found.includes('main.aux'), 'build artifacts are ignored');
  assert.ok(!found.includes('main.pdf'), 'main.pdf is ignored next to main.tex');
  assert.ok(found.includes('figures/diagram.pdf'), 'a PDF with no .tex sibling is kept');
});

test('scanLocalFiles: reports ignored directories with a trailing slash and does not descend', () => {
  const { files, ignored } = scanLocalFiles(root, loadIgnore(root));
  assert.ok(ignored.includes('build/'));
  assert.ok(!files.some((f) => f.relativePath.startsWith('build/')));
});

test('scanLocalFiles: --no-ignore disables filtering but not the dotfile rule', () => {
  const { files } = scanLocalFiles(root, loadIgnore(root, { disableAll: true }));
  const found = files.map((f) => f.relativePath).sort();
  assert.ok(found.includes('main.aux'));
  assert.ok(found.includes('build/ignored.tex'));
  assert.ok(!found.includes('.olcli.json'));
});

test('scanLocalFiles: every file carries an fs-usable path and an mtime', () => {
  const { files } = scanLocalFiles(root, loadIgnore(root));
  const main = files.find((f) => f.relativePath === 'main.tex');
  assert.ok(main);
  assert.equal(main.path, join(root, 'main.tex'));
  assert.ok(main.mtime instanceof Date);
});
