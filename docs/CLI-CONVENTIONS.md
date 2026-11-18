# CLI conventions

How olcli names things on the command line. Every new command and flag follows this page; `test/cli-conventions.test.ts` walks the command tree and fails when it does not. Exit statuses are in `olcli help exit-codes`, and what is covered by semver is in [STABILITY.md](STABILITY.md).

## Vocabulary

One name per concept. No new synonyms.

| Concept | Spelling | Notes |
|---|---|---|
| Project to act on | `-p, --project <project>` | Name or ID. Where a command also takes `[project]` as a positional, both work; giving both with different values is a usage error |
| Root `.tex` document | `-r, --resource <path>` | `compile`, `pdf`, `output`, `diff --latexdiff` |
| Preview without writing | `--dry-run` | On commands that write by default |
| Confirm a destructive or bulk write | `-y, --yes` | On commands that preview by default |
| Where a download goes | `-o, --output <path>` | |
| Machine-readable output | `--json` | One JSON value on stdout |
| Request log | `--verbose` | Global only; a subcommand must not declare it |
| Instance, cookie name, timeout | `--base-url`, `--cookie-name`, `--timeout` | Global only |
| Color | `--no-color` | Global only; `NO_COLOR` does the same |
| Session cookie for one run | `--cookie <session>` | Per command today; `auth --cookie` stores one |

## Deprecated spellings

Old spellings keep working as hidden aliases: they are not shown in the help, and on a terminal they print one line per run that names the new spelling. Nothing is printed when stderr is not a terminal, so scripts see no change. They are removed only in a major release.

| Old | New | Since |
|---|---|---|
| `diff --main <path>` | `diff -r, --resource <path>` | 0.19.0 |
| `project rename-bulk --apply` | `project rename-bulk -y, --yes` | 0.19.0 |
| `whoami`, `check` | `auth status` | 0.16.0 |

## Rules

1. **The root help does not grow.** 21 visible top-level commands. A new capability is a flag on an existing command or a subcommand of an existing group; a test fails above the budget.
2. **No subcommand option shadows a global option.** Commander gives a flag declared on both levels to the parent, so the subcommand's copy would never be set (this is how `sync --verbose` once stopped working). A test intersects every command's options with those of its ancestors.
3. **Short flags mean the same everywhere.** `-p` project, `-r` resource, `-y` yes, `-o` output, `-n` limit, `-t` template, `-U` unified context. A test fails when a short flag is bound to two different long names.
4. **Help topics, not commands.** Reference text goes under `olcli help <topic>` (`exit-codes`, `environment`).
5. **Experimental commands say so** in their description and help, and are listed as outside the stability promise in [STABILITY.md](STABILITY.md).

## Inconsistencies still open

Known places that do not follow the vocabulary yet. Each one gets the new spelling plus a hidden alias before 1.0.

- `--json` is missing on `pull`, `push`, `sync`, `diff`, `download`, `upload`, `delete`, `rename`, `zip`, `compile`, `pdf`, `output`, `project rename`, `project rename-bulk`, `config`, `ignored` and `logout`, and failures under `--json` are not JSON yet.
- `--dry-run` is missing on `upload`, `delete`, `rename`, `comments` writes and `changes accept`.
- `delete` and `changes accept` write without `--yes`; `changes reject`, `changes suggest` and `project rename-bulk` preview by default.
- `--cookie <session>` is repeated on most commands instead of being one global option.
- `config set-url`, `get-url`, `set-cookie-name`, `get-cookie-name`, `set-timeout`, `get-timeout` instead of `config get|set|list|unset <key>`.
- `upload --folder <id>` and `push --probe-folder` expose folder IDs; `auth --no-save-password` restates the default.
- `output [type]` guesses whether its argument is a type or a project name.
