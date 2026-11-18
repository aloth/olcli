import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, type Option } from 'commander';

// docs/CLI-CONVENTIONS.md as tests: the command tree is loaded without
// running anything (parse() is stubbed out) and checked against the
// vocabulary, the short-flag table and the documented command tables.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let cached: Promise<Command> | undefined;
function loadProgram(): Promise<Command> {
  cached ??= (async () => {
    const original = Command.prototype.parse;
    let captured: Command | undefined;
    Command.prototype.parse = function (this: Command) { captured = this; return this; } as typeof original;
    try {
      await import('../src/cli.js');
    } finally {
      Command.prototype.parse = original;
    }
    assert.ok(captured);
    return captured;
  })();
  return cached;
}

const isHidden = (c: Command): boolean => Boolean((c as unknown as { _hidden?: boolean })._hidden);
const optionHidden = (o: Option): boolean => Boolean((o as unknown as { hidden?: boolean }).hidden);

function walk(command: Command, visit: (c: Command, path: string[]) => void, path: string[] = []): void {
  visit(command, path);
  for (const sub of command.commands) walk(sub, visit, [...path, sub.name()]);
}

/** The vocabulary of docs/CLI-CONVENTIONS.md: a long flag may only be spelled one way. */
const CANONICAL: Record<string, string> = {
  '--project': '-p, --project <project>',
  '--resource': '-r, --resource <path>',
  '--yes': '-y, --yes',
  '--output': '-o, --output <path>',
  '--json': '--json',
  '--dry-run': '--dry-run',
};

/** Spellings that must not come back as visible options. */
const FORBIDDEN_VISIBLE = ['--main', '--apply', '--force-yes', '--confirm', '--preview', '--root', '--doc'];

test('options in the vocabulary are spelled one way everywhere', async () => {
  const program = await loadProgram();
  const wrong: string[] = [];
  walk(program, (command, path) => {
    for (const option of command.options) {
      const want = option.long ? CANONICAL[option.long] : undefined;
      if (want && option.flags !== want) wrong.push(`${path.join(' ')}: ${option.flags} (want ${want})`);
    }
  });
  assert.deepEqual(wrong, []);
});

test('no visible option uses a deprecated or synonym spelling', async () => {
  const program = await loadProgram();
  const found: string[] = [];
  walk(program, (command, path) => {
    for (const option of command.options) {
      if (!optionHidden(option) && option.long && FORBIDDEN_VISIBLE.includes(option.long)) found.push(`${path.join(' ')}: ${option.long}`);
    }
  });
  assert.deepEqual(found, []);
});

test('a short flag means the same long option on every command', async () => {
  const program = await loadProgram();
  const bound = new Map<string, Set<string>>();
  walk(program, (command) => {
    for (const option of command.options) {
      if (!option.short || !option.long) continue;
      if (!bound.has(option.short)) bound.set(option.short, new Set());
      bound.get(option.short)!.add(option.long);
    }
  });
  const conflicts = [...bound].filter(([, longs]) => longs.size > 1).map(([short, longs]) => `${short}: ${[...longs].join(', ')}`);
  assert.deepEqual(conflicts, []);
});

test('global-only options are not redeclared by any subcommand', async () => {
  const program = await loadProgram();
  const globals = ['--verbose', '--base-url', '--cookie-name', '--timeout', '--no-color'];
  const redeclared: string[] = [];
  walk(program, (command, path) => {
    if (path.length === 0) return;
    for (const option of command.options) {
      if (option.long && globals.includes(option.long)) redeclared.push(`${path.join(' ')}: ${option.long}`);
    }
  });
  assert.deepEqual(redeclared, []);
});

test('every top-level command that is visible has a description of at most 70 characters', async () => {
  const program = await loadProgram();
  const visible = program.commands.filter((c) => !isHidden(c));
  assert.equal(visible.length, 21, 'the root help budget (docs/CLI-CONVENTIONS.md rule 1)');
  for (const c of visible) assert.ok(c.description().length <= 70, `${c.name()}: ${c.description()}`);
});

function olcli(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'olcli-conv-'));
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OVERLEAF_') || k.startsWith('OLCLI_')) continue;
    base[k] = v;
  }
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(ROOT, 'src', 'cli.ts'), ...args], {
    encoding: 'utf-8',
    cwd: home,
    env: { ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NODE_NO_WARNINGS: '1', NO_COLOR: '1', ...env },
  });
}

test('deprecated aliases still parse, are hidden from help, and map to the new option', () => {
  // --main is accepted and reaches the same check as --resource: outside
  // --latexdiff both are refused as a usage error that names --resource.
  const main = olcli(['diff', '--main', 'x.tex']);
  assert.equal(main.status, 2, main.stderr);
  assert.match(main.stderr, /--resource only applies with --latexdiff/);
  // No notice on a pipe: scripts see no new stderr line.
  assert.doesNotMatch(main.stderr, /deprecated/);

  const help = olcli(['diff', '--help']);
  assert.doesNotMatch(help.stdout, /--main/);
  assert.match(help.stdout, /-r, --resource <path>/);

  const bulkHelp = olcli(['project', 'rename-bulk', '--help']);
  assert.doesNotMatch(bulkHelp.stdout, /--apply/);
  assert.match(bulkHelp.stdout, /-y, --yes/);
  // --apply still parses (the run then needs a session, so exit 4, not 2).
  assert.equal(olcli(['project', 'rename-bulk', '--apply', '--prefix', 'x']).status, 4);
});

test('the deprecation notice prints once per run, and only on a terminal', async () => {
  await loadProgram();
  const { deprecationNotice } = await import('../src/cli.js') as { deprecationNotice: (a: string, b: string, s: { isTTY?: boolean; write(t: string): unknown }) => boolean };
  const written: string[] = [];
  const tty = { isTTY: true, write: (t: string) => written.push(t) };
  assert.equal(deprecationNotice('--old-a', '--new-a', { isTTY: false, write: (t: string) => written.push(t) }), false);
  assert.equal(deprecationNotice('--old-a', '--new-a', tty), true);
  assert.equal(deprecationNotice('--old-a', '--new-a', tty), false);
  assert.equal(written.length, 1);
  assert.match(written[0], /'--old-a' is deprecated; use '--new-a'/);
});

/** `olcli a b` rows of a Markdown commands table. */
function documentedCommands(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf-8');
  return [...text.matchAll(/^\| `olcli ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/gm)].map((m) => m[1]);
}

test('README.md and SKILL.md command tables name only commands that exist, and list every visible leaf command', async () => {
  const program = await loadProgram();
  const leaves = new Set<string>();
  const known = new Set<string>();
  walk(program, (command, path) => {
    if (path.length === 0 || isHidden(command) || path[0] === 'help') return;
    known.add(path.join(' '));
    if (command.commands.length === 0) leaves.add(path.join(' '));
  });
  for (const file of ['README.md', 'SKILL.md']) {
    const rows = documentedCommands(file).map((row) => {
      const [first, second] = row.split(' ');
      return known.has(`${first} ${second}`) ? `${first} ${second}` : first;
    });
    const unknown = rows.filter((row) => !known.has(row));
    assert.deepEqual(unknown, [], `${file} names commands that do not exist`);
    const documented = new Set(rows);
    // README groups comments reopen/delete and the config getters into one row each.
    const allowedMissing = file === 'README.md'
      ? ['comments reopen', 'comments delete', 'config get-url', 'config set-cookie-name', 'config get-cookie-name', 'config set-timeout', 'config get-timeout']
      : [];
    const missing = [...leaves].filter((leaf) => !documented.has(leaf) && !allowedMissing.includes(leaf));
    assert.deepEqual(missing, [], `${file} misses commands`);
  }
});
