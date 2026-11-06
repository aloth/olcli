import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorDisabled, icon, isInteractive } from '../src/term.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'test', 'snapshots', 'root-help.txt');

function olcli(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'olcli-help-'));
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OVERLEAF_') || k.startsWith('OLCLI_') || k === 'NO_COLOR' || k === 'FORCE_COLOR') continue;
    base[k] = v;
  }
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(ROOT, 'src', 'cli.ts'), ...args], {
    encoding: 'utf-8',
    cwd: home,
    env: { ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NODE_NO_WARNINGS: '1', COLUMNS: '200', ...env },
  });
}

// Update with: UPDATE_SNAPSHOTS=1 npm test
test('root help matches the snapshot', () => {
  const result = olcli(['--help'], { NO_COLOR: '1' });
  assert.equal(result.status, 0, result.stderr);
  if (process.env.UPDATE_SNAPSHOTS) writeFileSync(SNAPSHOT, result.stdout);
  assert.equal(result.stdout, readFileSync(SNAPSHOT, 'utf-8'));
});

test('root help is grouped in workflow order', () => {
  const { stdout } = olcli(['--help'], { NO_COLOR: '1' });
  const headings = stdout.split('\n').filter((l) => /^[A-Z][A-Za-z]+:$/.test(l));
  assert.deepEqual(headings, ['Options:', 'Account:', 'Projects:', 'Sync:', 'Files:', 'Build:', 'Review:', 'Settings:', 'Help:', 'Environment:']);
  assert.doesNotMatch(stdout, /^Commands:$/m, 'every visible command needs a group');
});

test('root command descriptions are at most 70 characters', () => {
  const { stdout } = olcli(['--help'], { NO_COLOR: '1' });
  const section = stdout.slice(stdout.indexOf('Account:'), stdout.indexOf('Environment:'));
  const long = section.split('\n')
    .filter((l) => l.startsWith('  '))
    .map((l) => l.trim().split(/\s{2,}/)[1] ?? '')
    .filter((d) => d.length > 70);
  assert.deepEqual(long, []);
});

test('help text has no em dashes', () => {
  const { stdout } = olcli(['--help'], { NO_COLOR: '1' });
  assert.doesNotMatch(stdout, /\u2014/);
});

test('NO_COLOR and --no-color turn color off, even when FORCE_COLOR asks for it', () => {
  const ansi = /\u001b\[/;
  const forced = olcli(['ignored', '--no-default-ignore'], { FORCE_COLOR: '1' });
  assert.match(forced.stdout, ansi, 'expected color with FORCE_COLOR=1');
  assert.doesNotMatch(olcli(['ignored', '--no-default-ignore'], { FORCE_COLOR: '1', NO_COLOR: '1' }).stdout, ansi);
  assert.doesNotMatch(olcli(['--no-color', 'ignored', '--no-default-ignore'], { FORCE_COLOR: '1' }).stdout, ansi);
  assert.doesNotMatch(olcli(['ignored', '--no-default-ignore'], {}).stdout, ansi, 'a pipe gets no color');
});

test('--no-color is accepted as a global option', () => {
  const result = olcli(['--no-color', 'ignored', '/tmp']);
  assert.equal(result.status, 0, result.stderr);
});

test('colorDisabled follows no-color.org: set and non-empty', () => {
  assert.equal(colorDisabled({ NO_COLOR: '1' }, []), true);
  assert.equal(colorDisabled({ NO_COLOR: '' }, []), false);
  assert.equal(colorDisabled({}, ['node', 'olcli', '--no-color']), true);
  assert.equal(colorDisabled({}, ['node', 'olcli', '--', '--no-color']), false);
});

test('emoji and symbols only on an interactive stdout', () => {
  assert.equal(isInteractive({ isTTY: true }, {}), true);
  assert.equal(isInteractive({ isTTY: true }, { TERM: 'dumb' }), false);
  assert.equal(isInteractive({ isTTY: false }, {}), false);
  // The test runner's stdout is a pipe.
  if (!process.stdout.isTTY) assert.equal(icon('📄', 'doc'), 'doc');
});

test('spinner results use words, not symbols, when stderr is not a terminal', () => {
  const result = olcli(['list'], { NO_COLOR: '1' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr + result.stdout, /[\u2714\u2716\u26a0\u2139]/);
});
