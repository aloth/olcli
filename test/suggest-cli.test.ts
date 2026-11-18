import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { UsageError } from '../src/exit-codes.js';
import { MAX_SUGGESTION_EDITS, describeSuggestionPlan, parseSuggestionEdits, suggestionPlanJson, suggestionResultJson } from '../src/suggest-cli.js';
import type { SuggestionPlan } from '../src/client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDIT = { before: 'alpha ', deleted: 'gamma', inserted: 'beta', after: ' delta', hint: 6 };

function olcli(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'olcli-suggest-'));
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OVERLEAF_') || k.startsWith('OLCLI_')) continue;
    base[k] = v;
  }
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(ROOT, 'src', 'cli.ts'), ...args], {
    encoding: 'utf-8',
    cwd: home,
    input: options.input ?? '',
    env: { ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NODE_NO_WARNINGS: '1', NO_COLOR: '1', ...options.env },
  });
  return { ...result, home };
}

test('parseSuggestionEdits accepts an array and an object with edits, as the MCP tool and --json output carry', () => {
  assert.deepEqual(parseSuggestionEdits(JSON.stringify([EDIT])), [EDIT]);
  assert.deepEqual(parseSuggestionEdits(JSON.stringify({ edits: [EDIT] })), [EDIT]);
  const { hint: _hint, ...withoutHint } = EDIT;
  assert.deepEqual(parseSuggestionEdits(JSON.stringify([withoutHint])), [withoutHint]);
  // A result list from an earlier --json run can be fed back in.
  assert.deepEqual(parseSuggestionEdits(JSON.stringify({ results: [], edits: [{ ...EDIT, result: 'done' }] })), [EDIT]);
});

test('parseSuggestionEdits rejects bad input as a usage error that names the problem', () => {
  const cases: [string, RegExp][] = [
    ['not json', /not valid JSON/],
    ['{}', /must be a JSON array of edits/],
    ['[]', /contains no edits/],
    ['[1]', /edit 1: must be an object/],
    [JSON.stringify([{ ...EDIT, deleted: undefined }]), /edit 1: "deleted" must be a string/],
    [JSON.stringify([EDIT, { ...EDIT, hint: -1 }]), /edit 2: "hint" must be a non-negative integer/],
    [JSON.stringify([{ ...EDIT, inserted: 'x', extra: 1 }]), /edit 1: unknown field "extra"/],
    [JSON.stringify(Array.from({ length: MAX_SUGGESTION_EDITS + 1 }, () => EDIT)), /at most 100 per run/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => parseSuggestionEdits(input, 'edits.json'), (error: unknown) => error instanceof UsageError && message.test(error.message), input.slice(0, 40));
  }
});

const PLAN: SuggestionPlan = {
  docId: 'd1',
  path: 'main.tex',
  version: 7,
  edits: [
    { edit: EDIT, outcome: 'suggest', line: 1, column: 7 },
    { edit: { before: 'zz', deleted: 'a', inserted: 'b', after: 'zz' }, outcome: 'not-found' },
  ],
};

test('the preview shows the location and the suggested deletion and insertion, or why an edit is left alone', () => {
  assert.deepEqual(describeSuggestionPlan(PLAN), [
    '1. main.tex:1:7 becomes a suggestion',
    '   suggested deletion:  "gamma"',
    '   suggested insertion: "beta"',
    '   between "alpha " and " delta"',
    '2. neither the old nor the new text is in the document, left alone',
  ]);
});

test('--json carries the planned outcome per edit, and the result per edit after writing', () => {
  assert.deepEqual(suggestionPlanJson(PLAN), {
    applied: false,
    path: 'main.tex',
    version: 7,
    edits: [
      { ...EDIT, outcome: 'suggest', line: 1, column: 7 },
      { before: 'zz', deleted: 'a', inserted: 'b', after: 'zz', outcome: 'not-found' },
    ],
  });
  assert.deepEqual(suggestionResultJson('main.tex', [EDIT], ['done']), { applied: true, path: 'main.tex', results: [{ ...EDIT, result: 'done' }] });
});

test('changes suggest: usage errors exit 2 before anything is sent', () => {
  const missing = olcli(['changes', 'suggest', 'main.tex']);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /required option '--edits <path>'/);

  const bad = olcli(['changes', 'suggest', 'main.tex', 'Paper', '--edits', '-'], { input: '{"nope": true}' });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /stdin must be a JSON array of edits/);

  const absent = olcli(['changes', 'suggest', 'main.tex', 'Paper', '--edits', 'no-such-file.json']);
  assert.equal(absent.status, 2, absent.stderr);
  assert.match(absent.stderr, /Cannot read the edits from no-such-file\.json/);

  const both = olcli(['changes', 'suggest', 'main.tex', 'A', '--project', 'B', '--edits', '-'], { input: JSON.stringify([EDIT]) });
  assert.equal(both.status, 2, both.stderr);
});

test('changes suggest: valid edits without a session exit 4 (not signed in)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olcli-suggest-edits-'));
  writeFileSync(join(dir, 'edits.json'), JSON.stringify([EDIT]));
  const result = olcli(['changes', 'suggest', 'main.tex', 'Paper', '--edits', join(dir, 'edits.json')]);
  assert.equal(result.status, 4, result.stderr);
});

test('changes suggest --help says experimental, names the limits and the stability exception', () => {
  const help = olcli(['changes', 'suggest', '--help']);
  assert.equal(help.status, 0);
  for (const phrase of [/Experimental/, /outside the stability promise/, /sharejs-text-ot documents only/, /history-ot documents are refused/, /about 0\.2 s/, /needs edit access/, /exit 5/]) {
    assert.match(help.stdout, phrase);
  }
});

test('changes suggest is a subcommand, not a new top-level command', async () => {
  const original = Command.prototype.parse;
  let program: Command | undefined;
  Command.prototype.parse = function (this: Command) { program = this; return this; } as typeof original;
  try {
    await import('../src/cli.js');
  } finally {
    Command.prototype.parse = original;
  }
  const changes = program!.commands.find((c) => c.name() === 'changes');
  assert.ok(changes?.commands.some((c) => c.name() === 'suggest'));
  assert.ok(!program!.commands.some((c) => c.name() === 'suggest'));
});
