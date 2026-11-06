import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

// docs/index.html is the landing page (GitHub Pages). It drifted for months
// because nothing tied it to the code. This test reads every `olcli ...`
// command line on the page, visible text and code samples alike, and checks
// the command, subcommand and every flag against the real command tree. It
// also rejects em dashes anywhere in the file.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'docs', 'index.html');

// Same technique as cli-options.test.ts: load src/cli.ts with parse() stubbed
// out, so the program is built but no command runs. The module is evaluated
// once per process, so the program is cached.
let cached: Promise<Command> | undefined;
function loadProgram(): Promise<Command> {
  cached ??= importProgram();
  return cached;
}

async function importProgram(): Promise<Command> {
  const original = Command.prototype.parse;
  let captured: Command | undefined;
  Command.prototype.parse = function (this: Command) {
    captured = this;
    return this;
  } as typeof original;
  try {
    await import('../src/cli.js');
  } finally {
    Command.prototype.parse = original;
  }
  assert.ok(captured, 'src/cli.ts did not call program.parse()');
  return captured;
}

function isHidden(command: Command): boolean {
  return Boolean((command as unknown as { _hidden?: boolean })._hidden);
}

function flagsOf(command: Command): string[] {
  return command.options.flatMap((option) => [option.long, option.short]).filter((flag): flag is string => Boolean(flag));
}

function findSub(parent: Command, name: string): Command | undefined {
  return parent.commands.find((c) => !isHidden(c) && (c.name() === name || c.aliases().includes(name)));
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** The page as plain text, one line per block or <br>, without scripts and styles. */
function pageText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|code|pre|li|h[1-6]|section|title|td|tr|a)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * Every `olcli <word> ...` invocation in `text`, cut at the end of the shell
 * command (newline, pipe, &&, ;, a line continuation). "olcli" preceded by
 * "/" or "@" is a package or URL path, not a command.
 */
function invocations(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const pattern = /(?<![/@\w-])olcli\s+([a-z][^\n|;&\\]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) found.push(`olcli ${match[1].trim()}`);
  }
  return found;
}

/** Split a command line into words, keeping quoted arguments together. */
function words(commandLine: string): string[] {
  return commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/** Problems with one invocation against the command tree; empty when it is valid. */
function check(program: Command, commandLine: string): string[] {
  const [, name, ...rest] = words(commandLine);
  const command = findSub(program, name);
  if (!command) return [`${commandLine}: no command "${name}"`];
  const chain = [program, command];
  const args = [...rest];
  if (command.commands.length > 0 && args.length > 0 && !args[0].startsWith('-')) {
    const sub = findSub(command, args[0]);
    if (sub) {
      chain.push(sub);
      args.shift();
    } else if (!command.registeredArguments?.length) {
      return [`${commandLine}: no subcommand "${command.name()} ${args[0]}"`];
    }
  }
  const known = new Set(['--help', '-h', ...chain.flatMap(flagsOf)]);
  const problems: string[] = [];
  for (const arg of args) {
    if (!/^--?[A-Za-z]/.test(arg)) continue;
    const flag = arg.split('=')[0];
    if (!known.has(flag)) problems.push(`${commandLine}: no option ${flag} on "${chain.slice(1).map((c) => c.name()).join(' ')}"`);
  }
  return problems;
}

// Failures of the page as it is today. updated with the 0.16 landing page
// rewrite: that change must make the page pass and empty this list. An entry
// that no longer fails also fails the test, so the list cannot go stale.
const KNOWN_FAILURES: string[] = [
  'em dash on line 6',
  'em dash on line 8',
  'em dash on line 14',
  'em dash on line 139',
  'em dash on line 185',
  'em dash on line 213',
  'em dash on line 233',
];

test('the landing page names only commands, subcommands and flags that exist, and has no em dashes', async () => {
  const program = await loadProgram();
  const html = readFileSync(PAGE, 'utf-8');

  const lines = invocations(pageText(html));
  assert.ok(lines.length >= 5, `expected the code samples on the page, found: ${lines.join(' / ')}`);

  const failures = [
    ...lines.flatMap((line) => check(program, line)),
    ...html.split('\n').flatMap((line, i) => (line.includes('\u2014') ? [`em dash on line ${i + 1}`] : [])),
  ];

  const unexpected = failures.filter((f) => !KNOWN_FAILURES.includes(f));
  const fixed = KNOWN_FAILURES.filter((f) => !failures.includes(f));
  assert.deepEqual(unexpected, [], 'docs/index.html does not match the command tree');
  assert.deepEqual(fixed, [], 'these known failures are fixed now; remove them from KNOWN_FAILURES');
});

test('the drift check itself catches unknown commands, subcommands and flags', async () => {
  const program = await loadProgram();
  const text = pageText('<code>olcli pull "My Paper" paper<br>olcli frobnicate<br>olcli auth status --jsonn<br>olcli pdf --bogus -o x.pdf</code><p>npm i @aloth/olcli</p>');
  const lines = invocations(text);
  assert.deepEqual(lines, ['olcli pull "My Paper" paper', 'olcli frobnicate', 'olcli auth status --jsonn', 'olcli pdf --bogus -o x.pdf']);
  assert.deepEqual(lines.flatMap((line) => check(program, line)), [
    'olcli frobnicate: no command "frobnicate"',
    'olcli auth status --jsonn: no option --jsonn on "auth status"',
    'olcli pdf --bogus -o x.pdf: no option --bogus on "pdf"',
  ]);
  // Global options count on every command.
  assert.deepEqual(check(program, 'olcli list --verbose --json'), []);
  // Hidden aliases are not advertised on the page.
  assert.match(check(program, 'olcli whoami').join(), /no command "whoami"/);
});

test('every command sample on the landing page is read', () => {
  const lines = invocations(pageText(readFileSync(PAGE, 'utf-8')));
  assert.ok(lines.length >= 9, lines.join(' / '));
  assert.ok(lines.some((l) => l.startsWith('olcli sync')));
  assert.ok(lines.some((l) => l.startsWith('olcli list --json')));
});
