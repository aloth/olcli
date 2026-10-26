import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the real entry points in a child process with an empty HOME, an empty
// working directory and no OVERLEAF_* variables, so no stored session, no
// .olauth file and no network request is ever involved. Nothing here can touch
// the credentials of whoever runs the suite.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TSX = import.meta.resolve('tsx');

let home: string;
let cwd: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'olcli-offline-'));
  cwd = join(home, 'work');
  mkdirSync(cwd);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('OVERLEAF_') || key.startsWith('OLCLI_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    APPDATA: join(home, 'AppData'),
    NODE_NO_WARNINGS: '1',
    NO_COLOR: '1',
    ...extra,
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}): Run {
  const result = spawnSync(process.execPath, ['--import', TSX, join(SRC, script), ...args], {
    cwd,
    env: cleanEnv(options.env),
    input: options.input ?? '',
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function olcli(...args: string[]): Run {
  return run('cli.ts', args);
}

test('remote helper without credentials names an existing login command', () => {
  const gitDir = join(home, 'helper.git');
  const result = run(
    'remote-helper.ts',
    ['origin', 'https://www.overleaf.com/project/0123456789abcdef01234567'],
    { input: 'capabilities\n\nimport refs/heads/main\n\n', env: { GIT_DIR: gitDir } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No Overleaf credentials found/);
  assert.doesNotMatch(result.stderr, /olcli login/);

  const named = result.stderr.match(/Run '(olcli [a-z-]+)'/);
  assert.ok(named, `expected a command suggestion in: ${result.stderr}`);
  assert.equal(named[1], 'olcli auth');

  const help = olcli('auth', '--help');
  assert.equal(help.status, 0, help.stderr);
});
