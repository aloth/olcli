import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DIFF_OUTPUT_DIR,
  REMOTE_SCRATCH_NAME,
  RootDocumentError,
  buildLatexdiffArgs,
  declaresDocumentClass,
  diffOutputPath,
  findRootCandidates,
  isTexPath,
  latexdiffInstallHint,
  materializeTree,
  remoteScratchPath,
  resolveRootDocument,
} from '../src/latexdiff.js';

const buf = (s: string) => Buffer.from(s, 'utf-8');
const ROOT = '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n';

// ─────────────────────────────────────────────────────────────────────────────
// Root document detection
// ─────────────────────────────────────────────────────────────────────────────

test('declaresDocumentClass: finds a document class with and without options', () => {
  assert.equal(declaresDocumentClass(buf('\\documentclass{article}\n')), true);
  assert.equal(declaresDocumentClass(buf('\\documentclass[12pt,a4paper]{report}\n')), true);
  assert.equal(declaresDocumentClass(buf('\\documentclass  {book}\n')), true);
});

test('declaresDocumentClass: a commented-out declaration does not count', () => {
  // Chapters split out of a standalone document routinely keep their old
  // preamble commented out; counting it would make every chapter a candidate.
  assert.equal(declaresDocumentClass(buf('% \\documentclass{article}\n\\section{One}\n')), false);
  assert.equal(declaresDocumentClass(buf('\\section{One} % \\documentclass{article}\n')), false);
});

test('declaresDocumentClass: an escaped percent does not start a comment', () => {
  assert.equal(declaresDocumentClass(buf('50\\% off \\documentclass{article}\n')), true);
  // An escaped backslash before the percent means the percent is a comment again.
  assert.equal(declaresDocumentClass(buf('a\\\\% \\documentclass{article}\n')), false);
});

test('declaresDocumentClass: prose mentioning the command is not a declaration', () => {
  assert.equal(declaresDocumentClass(buf('The documentclass matters.\n')), false);
  assert.equal(declaresDocumentClass(buf('\\documentclasses are described below\n')), false);
});

test('isTexPath: .tex and .ltx, case-insensitive', () => {
  assert.equal(isTexPath('main.tex'), true);
  assert.equal(isTexPath('sections/Intro.TeX'), true);
  assert.equal(isTexPath('paper.ltx'), true);
  assert.equal(isTexPath('refs.bib'), false);
  assert.equal(isTexPath('figures/plot.pdf'), false);
});

test('findRootCandidates: only .tex files that declare a class, sorted', () => {
  const files = new Map([
    ['z.tex', buf(ROOT)],
    ['a.tex', buf(ROOT)],
    ['sections/intro.tex', buf('\\section{Intro}\n')],
    ['refs.bib', buf('@book{x}\n')],
    ['notes.txt', buf('\\documentclass{article}\n')],
  ]);
  assert.deepEqual(findRootCandidates(files), ['a.tex', 'z.tex']);
});

test('resolveRootDocument: a single candidate is used without asking', () => {
  const files = new Map([
    ['main.tex', buf(ROOT)],
    ['sections/intro.tex', buf('\\section{Intro}\n')],
  ]);
  assert.equal(resolveRootDocument(files), 'main.tex');
});

test('resolveRootDocument: ambiguity is reported, never guessed', () => {
  // Silently picking one produces a plausible PDF describing the wrong
  // revision, which is the failure hardest for a reviewer to notice.
  const files = new Map([['paper.tex', buf(ROOT)], ['poster.tex', buf(ROOT)]]);
  assert.throws(
    () => resolveRootDocument(files),
    (error: unknown) => {
      assert.ok(error instanceof RootDocumentError);
      assert.deepEqual(error.candidates, ['paper.tex', 'poster.tex']);
      assert.match(error.message, /--main/);
      return true;
    },
  );
});

test('resolveRootDocument: no candidate at all is an error naming the flag', () => {
  const files = new Map([['sections/intro.tex', buf('\\section{Intro}\n')]]);
  assert.throws(() => resolveRootDocument(files), /--main/);
});

test('resolveRootDocument: --main wins, including over the heuristic', () => {
  const files = new Map([['main.tex', buf(ROOT)], ['sections/intro.tex', buf('\\section{Intro}\n')]]);
  assert.equal(resolveRootDocument(files, 'sections/intro.tex'), 'sections/intro.tex');
});

test('resolveRootDocument: --main for a file that is not in the tree explains why', () => {
  const files = new Map([['main.tex', buf(ROOT)]]);
  assert.throws(() => resolveRootDocument(files, 'missing.tex'), /ignore rule/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Argument construction
// ─────────────────────────────────────────────────────────────────────────────

test('buildLatexdiffArgs: flattens by default, old side first', () => {
  // Orientation is the whole meaning of the output: old is the remote.
  assert.deepEqual(
    buildLatexdiffArgs('/tmp/remote/main.tex', 'local/main.tex'),
    ['--flatten', '/tmp/remote/main.tex', 'local/main.tex'],
  );
});

test('buildLatexdiffArgs: --no-flatten drops the flag and nothing else', () => {
  assert.deepEqual(
    buildLatexdiffArgs('old.tex', 'new.tex', { flatten: false }),
    ['old.tex', 'new.tex'],
  );
});

test('buildLatexdiffArgs: pass-through options come before the file arguments', () => {
  // latexdiff reads the last two positional arguments as old and new, so an
  // option appended after them would be taken for a filename.
  assert.deepEqual(
    buildLatexdiffArgs('old.tex', 'new.tex', { extra: ['--math-markup=0', '--type=CFONT'] }),
    ['--flatten', '--math-markup=0', '--type=CFONT', 'old.tex', 'new.tex'],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Output locations
// ─────────────────────────────────────────────────────────────────────────────

test('diffOutputPath: named after the root document, inside the dotted directory', () => {
  assert.equal(diffOutputPath('main.tex', 'tex'), `${DIFF_OUTPUT_DIR}/main-diff.tex`);
  assert.equal(diffOutputPath('main.tex', 'pdf'), `${DIFF_OUTPUT_DIR}/main-diff.pdf`);
});

test('diffOutputPath: a nested root document still writes to one flat directory', () => {
  // The flattened markup is a single self-contained file; mirroring the source
  // folder would only make it harder to find.
  assert.equal(diffOutputPath('thesis/paper.ltx', 'tex'), `${DIFF_OUTPUT_DIR}/paper-diff.tex`);
});

test('diffOutputPath: the output directory is dotted so a push cannot pick it up', () => {
  // scanLocalFiles skips dotted entries before any ignore rule is consulted.
  assert.ok(DIFF_OUTPUT_DIR.startsWith('.'));
});

test('remoteScratchPath: sits next to the root document', () => {
  // Relative \includegraphics and \bibliography paths in the flattened file
  // resolve from the root document's folder, so the upload has to share it.
  assert.equal(remoteScratchPath('main.tex'), REMOTE_SCRATCH_NAME);
  assert.equal(remoteScratchPath('thesis/paper.tex'), `thesis/${REMOTE_SCRATCH_NAME}`);
  assert.equal(remoteScratchPath('a/b/c.tex'), `a/b/${REMOTE_SCRATCH_NAME}`);
});

test('latexdiffInstallHint: names something installable on each platform', () => {
  assert.match(latexdiffInstallHint('darwin'), /brew/);
  assert.match(latexdiffInstallHint('win32'), /MiKTeX|TeX Live/);
  assert.match(latexdiffInstallHint('linux'), /apt|TeX Live/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Materializing the remote side
// ─────────────────────────────────────────────────────────────────────────────

test('materializeTree: writes the whole tree, folders included', () => {
  // --flatten resolves each \input relative to its own side, so the remote
  // needs its structure on disk - the root document alone is not enough.
  const dir = mkdtempSync(join(tmpdir(), 'olcli-materialize-'));
  try {
    const written = materializeTree(dir, new Map([
      ['main.tex', buf(ROOT)],
      ['sections/intro.tex', buf('\\section{Intro}\n')],
      ['figures/plot.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00])],
    ]));

    assert.equal(written, 3);
    assert.equal(readFileSync(join(dir, 'main.tex'), 'utf-8'), ROOT);
    assert.equal(readFileSync(join(dir, 'sections', 'intro.tex'), 'utf-8'), '\\section{Intro}\n');
    assert.equal(readFileSync(join(dir, 'figures', 'plot.pdf')).length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeTree: entries escaping the destination are dropped, not written', () => {
  // This writes files, and a path that was safe relative to the target
  // directory is not automatically safe relative to a temporary one. See #44.
  const dir = mkdtempSync(join(tmpdir(), 'olcli-materialize-'));
  try {
    const written = materializeTree(dir, new Map([
      ['main.tex', buf(ROOT)],
      ['../escaped.tex', buf('nope\n')],
      ['../../escaped-twice.tex', buf('nope\n')],
    ]));

    assert.equal(written, 1);
    assert.ok(existsSync(join(dir, 'main.tex')));
    assert.equal(existsSync(join(dir, '..', 'escaped.tex')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
