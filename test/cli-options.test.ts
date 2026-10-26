import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';

// Loads the real command tree from src/cli.ts without running it: parse() is
// replaced for the duration of the import, so no command action ever runs.
async function loadProgram(): Promise<Command> {
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

function flagsOf(command: Command): string[] {
  return command.options.flatMap((option) => [option.long, option.short]).filter((flag): flag is string => Boolean(flag));
}

function path(chain: Command[]): string {
  return chain.map((command) => command.name()).join(' ');
}

// Commander assigns a flag that is declared on both a parent and a subcommand
// to the parent, whatever its position on the command line. The subcommand's
// copy then can never be set, and its help advertises an option that does
// nothing. That is how `sync --verbose` stopped printing its file list.
test('no subcommand declares an option that a parent command already declares', async () => {
  const program = await loadProgram();
  assert.ok(flagsOf(program).includes('--verbose'), 'expected the global --verbose on the program');

  const overlaps: string[] = [];
  let checked = 0;
  const visit = (command: Command, ancestors: Command[]): void => {
    if (ancestors.length > 0) {
      checked++;
      for (const flag of flagsOf(command)) {
        for (const ancestor of ancestors) {
          if (flagsOf(ancestor).includes(flag)) {
            overlaps.push(`${path([...ancestors, command])}: ${flag} is also declared on ${path(ancestors.slice(0, ancestors.indexOf(ancestor) + 1))}`);
          }
        }
      }
    }
    for (const sub of command.commands) visit(sub, [...ancestors, command]);
  };
  visit(program, []);

  assert.ok(checked > 20, `expected the full command tree, saw ${checked} subcommands`);
  assert.deepEqual(overlaps, []);
});
