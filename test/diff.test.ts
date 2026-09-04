import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareTrees,
  filterRemoteTree,
  renderFileDiff,
  isBinary,
  statusLetter,
} from '../src/diff.js';
import { loadIgnore } from '../src/ignore.js';

const buf = (s: string) => Buffer.from(s, 'utf-8');
const remoteEntry = (path: string, content = 'x\n') => ({ path, data: buf(content) });

test('compareTrees: classifies added, deleted, modified and unchanged', () => {
  const local = new Map([
    ['main.tex', buf('a\n')],
    ['new.tex', buf('new\n')],
    ['same.tex', buf('same\n')],
  ]);
  const remote = new Map([
    ['main.tex', buf('b\n')],
    ['gone.tex', buf('gone\n')],
    ['same.tex', buf('same\n')],
  ]);

  const result = compareTrees(local, remote);
  const byPath = Object.fromEntries(result.map((e) => [e.path, e.status]));

  assert.equal(byPath['main.tex'], 'modified');
  assert.equal(byPath['new.tex'], 'added');
  assert.equal(byPath['gone.tex'], 'deleted');
  assert.equal(byPath['same.tex'], 'unchanged');
});

test('compareTrees: output is sorted by path for stable diffs', () => {
  const local = new Map([['z.tex', buf('z')], ['a.tex', buf('a')], ['m.tex', buf('m')]]);
  const result = compareTrees(local, new Map());
  assert.deepEqual(result.map((e) => e.path), ['a.tex', 'm.tex', 'z.tex']);
});

test('compareTrees: byte-identical files are unchanged, not modified', () => {
  // Same characters, and the comparison must not go through a lossy decode.
  const bytes = Buffer.from([0xc3, 0xa9, 0x0a]);
  const result = compareTrees(new Map([['a.tex', bytes]]), new Map([['a.tex', Buffer.from(bytes)]]));
  assert.equal(result[0].status, 'unchanged');
});

test('compareTrees: trailing-newline-only difference is a real modification', () => {
  const result = compareTrees(
    new Map([['a.tex', buf('x\n')]]),
    new Map([['a.tex', buf('x')]]),
  );
  assert.equal(result[0].status, 'modified');
});

test('compareTrees: CRLF vs LF is a real modification', () => {
  const result = compareTrees(
    new Map([['a.tex', buf('x\r\ny\r\n')]]),
    new Map([['a.tex', buf('x\ny\n')]]),
  );
  assert.equal(result[0].status, 'modified');
});

test('isBinary: NUL bytes mark a file binary, plain text does not', () => {
  assert.equal(isBinary(buf('\\documentclass{article}\n')), false);
  assert.equal(isBinary(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01])), true);
  assert.equal(isBinary(Buffer.alloc(0)), false);
});

test('isBinary: only the first 8000 bytes are sniffed', () => {
  const late = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
  assert.equal(isBinary(late), false);
});

test('compareTrees: a file that is binary on either side is flagged binary', () => {
  const result = compareTrees(
    new Map([['fig.pdf', buf('text now')]]),
    new Map([['fig.pdf', Buffer.from([0x00, 0x01])]]),
  );
  assert.equal(result[0].binary, true);
});

test('renderFileDiff: a/ is the remote and b/ is local, so + is what push would write', () => {
  const entry = { path: 'main.tex', status: 'modified' as const, binary: false };
  const patch = renderFileDiff(entry, buf('hello\nthere\n'), buf('hello\nworld\n'));

  assert.match(patch, /^diff --olcli a\/main\.tex b\/main\.tex\n/);
  assert.match(patch, /--- a\/main\.tex/);
  assert.match(patch, /\+\+\+ b\/main\.tex/);
  assert.match(patch, /^-world$/m, 'remote content appears as a removal');
  assert.match(patch, /^\+there$/m, 'local content appears as an addition');
  assert.doesNotMatch(patch, /^=+$/m, 'jsdiff separator line is stripped');
});

test('renderFileDiff: added files diff against /dev/null', () => {
  const entry = { path: 'new.tex', status: 'added' as const, binary: false };
  const patch = renderFileDiff(entry, buf('fresh\n'), undefined);
  assert.match(patch, /--- \/dev\/null/);
  assert.match(patch, /\+\+\+ b\/new\.tex/);
  assert.match(patch, /^\+fresh$/m);
});

test('renderFileDiff: remote-only files diff towards /dev/null', () => {
  const entry = { path: 'old.tex', status: 'deleted' as const, binary: false };
  const patch = renderFileDiff(entry, undefined, buf('stale\n'));
  assert.match(patch, /--- a\/old\.tex/);
  assert.match(patch, /\+\+\+ \/dev\/null/);
  assert.match(patch, /^-stale$/m);
});

test('renderFileDiff: binary files get a summary line, never a patch', () => {
  const entry = { path: 'figures/plot.pdf', status: 'modified' as const, binary: true };
  const patch = renderFileDiff(entry, Buffer.from([0x00, 0x01]), Buffer.from([0x00, 0x02]));
  assert.equal(
    patch,
    'diff --olcli a/figures/plot.pdf b/figures/plot.pdf\n' +
    'Binary files a/figures/plot.pdf and b/figures/plot.pdf differ\n',
  );
  assert.doesNotMatch(patch, /@@/);
});

test('renderFileDiff: unchanged files render nothing', () => {
  const entry = { path: 'a.tex', status: 'unchanged' as const, binary: false };
  assert.equal(renderFileDiff(entry, buf('x'), buf('x')), '');
});

test('renderFileDiff: context width is configurable', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const changed = lines.replace('line 10', 'line TEN');
  const entry = { path: 'a.tex', status: 'modified' as const, binary: false };

  const wide = renderFileDiff(entry, buf(changed), buf(lines), { context: 5 });
  const narrow = renderFileDiff(entry, buf(changed), buf(lines), { context: 1 });

  assert.ok(wide.split('\n').length > narrow.split('\n').length);
  assert.match(narrow, /@@ -10,3 \+10,3 @@/);
});

test('statusLetter: mirrors git status shorthand', () => {
  assert.equal(statusLetter('added'), 'A');
  assert.equal(statusLetter('deleted'), 'D');
  assert.equal(statusLetter('modified'), 'M');
});

test('filterRemoteTree: drops archive entries the ignore layers would skip locally', () => {
  const ctx = loadIgnore('/nonexistent-project-root');
  const tree = filterRemoteTree([
    remoteEntry('main.tex'),
    remoteEntry('output.pdf'),
    remoteEntry('main.aux'),
    remoteEntry('figures/diagram.png'),
  ], ctx);

  assert.deepEqual([...tree.keys()].sort(), ['figures/diagram.png', 'main.tex']);
});

test('filterRemoteTree: applies the PDF sibling rule per folder, not globally', () => {
  const ctx = loadIgnore('/nonexistent-project-root');
  const tree = filterRemoteTree([
    remoteEntry('main.tex'),
    remoteEntry('main.pdf'),          // sibling of main.tex -> ignored
    remoteEntry('figures/main.pdf'),  // no main.tex in figures/ -> kept
  ], ctx);

  assert.ok(!tree.has('main.pdf'));
  assert.ok(tree.has('figures/main.pdf'));
});

test('filterRemoteTree: mirrors the local scan by skipping dot entries', () => {
  const ctx = loadIgnore('/nonexistent-project-root');
  const tree = filterRemoteTree([
    remoteEntry('main.tex'),
    remoteEntry('.latexmkrc'),
    remoteEntry('.github/workflows/build.yml'),
  ], ctx);

  assert.deepEqual([...tree.keys()], ['main.tex']);
});

test('filterRemoteTree: rejects unsafe archive entries via the caller predicate', () => {
  const ctx = loadIgnore('/nonexistent-project-root');
  const tree = filterRemoteTree(
    [remoteEntry('main.tex'), remoteEntry('../escape.tex')],
    ctx,
    (path) => !path.startsWith('..'),
  );

  assert.deepEqual([...tree.keys()], ['main.tex']);
});

test('filterRemoteTree: normalizes backslash separators to forward slashes', () => {
  const ctx = loadIgnore('/nonexistent-project-root');
  const tree = filterRemoteTree([remoteEntry('chapters\\intro.tex')], ctx);
  assert.deepEqual([...tree.keys()], ['chapters/intro.tex']);
});

test('filterRemoteTree: --no-ignore keeps artifacts but still skips dot entries', () => {
  const ctx = loadIgnore('/nonexistent-project-root', { disableAll: true });
  const tree = filterRemoteTree([
    remoteEntry('main.aux'),
    remoteEntry('output.pdf'),
    remoteEntry('.latexmkrc'),
  ], ctx);

  assert.deepEqual([...tree.keys()].sort(), ['main.aux', 'output.pdf']);
});

test('renderFileDiff: a non-numeric context falls back to the default', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const changed = lines.replace('line 10', 'line TEN');
  const target = { path: 'a.tex', status: 'modified' as const, binary: false };

  const bad = renderFileDiff(target, buf(changed), buf(lines), { context: NaN });
  const good = renderFileDiff(target, buf(changed), buf(lines), { context: 3 });

  assert.equal(bad, good);
  assert.match(bad, /^\+line TEN$/m);
});
