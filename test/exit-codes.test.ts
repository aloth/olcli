import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, ConflictError, NotSignedInError, UsageError, commanderExitCode, exitCodeFor } from '../src/exit-codes.js';
import { CaptchaRequiredError, HttpStatusError, SessionExpiredError } from '../src/errors.js';
import { RejectConflictError } from '../src/tracked-changes.js';
import { PromptCancelled } from '../src/prompt.js';
import { ProjectNotFoundError } from '../src/project-match.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function olcli(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'olcli-exit-'));
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

test('the exit-code table has the documented numbers', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, FAILURE: 1, USAGE: 2, DIFFERENCES: 3, AUTH: 4, CONFLICT: 5, INTERRUPTED: 130 });
});

test('exitCodeFor maps typed errors to the table', () => {
  assert.equal(exitCodeFor(new UsageError('x')), 2);
  assert.equal(exitCodeFor(new NotSignedInError()), 4);
  assert.equal(exitCodeFor(new SessionExpiredError('HTTP 403', 403)), 4);
  assert.equal(exitCodeFor(new CaptchaRequiredError('www.overleaf.com', 400)), 4);
  assert.equal(exitCodeFor(new ConflictError('x')), 5);
  assert.equal(exitCodeFor(new RejectConflictError('x')), 5);
  assert.equal(exitCodeFor(new PromptCancelled()), 130);
  assert.equal(exitCodeFor(new HttpStatusError('Failed', 500)), 1);
  assert.equal(exitCodeFor(new ProjectNotFoundError('x', [])), 1);
  assert.equal(exitCodeFor(new Error('anything')), 1);
  assert.equal(exitCodeFor('not an error'), 1);
});

test('commanderExitCode keeps help and version, maps parse errors to 2', () => {
  assert.equal(commanderExitCode({ exitCode: 0, code: 'commander.helpDisplayed' }), 0);
  assert.equal(commanderExitCode({ exitCode: 0, code: 'commander.version' }), 0);
  assert.equal(commanderExitCode({ exitCode: 1, code: 'commander.help' }), 2, 'help shown for an incomplete command line');
  assert.equal(commanderExitCode({ exitCode: 1, code: 'commander.unknownOption' }), 2);
  assert.equal(commanderExitCode({ exitCode: 1, code: 'commander.missingArgument' }), 2);
  assert.equal(commanderExitCode({ exitCode: 1, code: 'commander.unknownCommand' }), 2);
});

test('usage errors exit 2 on every command, at every level', () => {
  assert.equal(olcli(['list', '--bogus']).status, 2);
  assert.equal(olcli(['comments', 'list', '--bogus']).status, 2);
  assert.equal(olcli(['changes', 'accept']).status, 2, 'missing argument');
  assert.equal(olcli(['no-such-command']).status, 2);
  assert.equal(olcli(['comments']).status, 2, 'group without a subcommand');
  assert.equal(olcli(['--timeout']).status, 2, 'missing option value');
  assert.equal(olcli(['config', 'set-timeout', 'soon']).status, 2, 'invalid value');
  assert.equal(olcli(['project', 'create', 'x', '--template', 'fancy']).status, 2);
  assert.equal(olcli(['push']).status, 2, 'no project');
});

test('help and version still exit 0', () => {
  assert.equal(olcli(['--help']).status, 0);
  assert.equal(olcli(['--version']).status, 0);
  assert.equal(olcli(['list', '--help']).status, 0);
  assert.equal(olcli(['help', 'list']).status, 0);
});

test('not signed in exits 4, on commands and on auth status', () => {
  const list = olcli(['list']);
  assert.equal(list.status, 4, list.stderr);
  assert.match(list.stderr, /No session cookie or password credentials found/);
  assert.equal(olcli(['auth', 'status']).status, 4);
  const json = olcli(['auth', 'status', '--json']);
  assert.equal(json.status, 4);
  assert.equal(JSON.parse(json.stdout).signedIn, false);
});

test('olcli help exit-codes and olcli help environment print the topics', () => {
  const codes = olcli(['help', 'exit-codes']);
  assert.equal(codes.status, 0, codes.stderr);
  for (const line of [/^ {2}0 {4}success/m, /^ {2}2 {4}usage error/m, /^ {2}4 {4}not signed in/m, /^ {2}5 {4}conflict/m, /^ {2}130 {2}interrupted/m]) {
    assert.match(codes.stdout, line);
  }
  assert.match(codes.stdout, /diff --exit-code keeps the statuses of diff\(1\)/);

  const env = olcli(['help', 'environment']);
  assert.equal(env.status, 0, env.stderr);
  for (const name of ['OVERLEAF_SESSION', 'OVERLEAF_BASE_URL', 'OVERLEAF_COOKIE_NAME', 'OVERLEAF_TIMEOUT', 'OLCLI_CONCURRENCY', 'OLCLI_BROWSER', 'HTTPS_PROXY', 'NO_PROXY', 'NO_COLOR']) {
    assert.match(env.stdout, new RegExp(`\\b${name}\\b`));
  }

  // Global options before `help` are skipped; an unknown topic is still a usage error.
  assert.equal(olcli(['--verbose', 'help', 'exit-codes']).status, 0);
  assert.equal(olcli(['help', 'no-such-topic']).status, 2);
});

test('help topics add no top-level command', () => {
  const help = olcli(['--help']);
  assert.doesNotMatch(help.stdout, /^ {2}exit-codes\b/m);
  assert.match(help.stdout, /help \[command\] +Help for a command, or a topic: exit-codes, environment/);
});
