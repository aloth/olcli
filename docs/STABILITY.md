# Stability

From 1.0.0, olcli follows [semantic versioning](https://semver.org). This page says what that promise covers, what it does not, and how a change that breaks it is made. Until 1.0.0 the same rules are applied as far as possible, and any change that would break them is listed in the CHANGELOG as a behavior change.

## Covered

A minor or patch release does not break these. New entries may be added in a minor release.

- **Command and option names** of `olcli`, including the spellings in [CLI-CONVENTIONS.md](CLI-CONVENTIONS.md), the positional arguments and their order, and the hidden aliases of deprecated spellings.
- **Exit statuses** as printed by `olcli help exit-codes`: 0 success, 1 failure, 2 usage error, 3 reserved, 4 not signed in or session rejected, 5 conflict, 130 interrupted. `diff --exit-code` keeps 0 same, 1 different, 2 failed.
- **JSON output** of `--json`: field names and their types. A minor release may add fields, and may add values to a field that lists outcomes or statuses; it does not rename, remove or retype a field. Parse JSON output with that in mind: ignore fields you do not know.
- **Environment variables** listed in `olcli help environment`, and their meaning.
- **The library API**: the exports of `@aloth/olcli` listed in [LIBRARY.md](LIBRARY.md), their names, parameters and return types. Adding an optional parameter or a field to a returned object is a minor change.
- **The MCP server**: tool names and their input schemas. A minor release may add tools and optional input fields; it does not rename or remove a tool or make an optional field required. Tools that write keep asking for confirmation.
- **The git remote helper**: the `overleaf::` URL forms it accepts.
- **Node.js support**: 1.0 requires Node 22 or newer. The minimum rises to Node 24 in 1.1, after Node 22 reaches its end of life. A rise of the minimum is announced at least one minor release in advance, as a notice olcli prints on the older runtime, and is never part of a patch release.

## Not covered

These can change in any release:

- **Human-readable output**: wording, layout, colors, spinners, the order of lines, and anything printed on stderr. Scripts should use `--json` and the exit status.
- **Overleaf itself**. olcli talks to Overleaf's web endpoints, which are not a public API and change without notice. When Overleaf changes one, olcli follows in a patch release; a capability Overleaf removes cannot be kept.
- **Anything marked experimental** in its help text or in the docs, today `olcli changes suggest`, the MCP tool `suggest_changes` and the library methods `suggestChanges` and `planSuggestions`. Experimental commands and tools may change or go away in a minor release; when one becomes stable, the CHANGELOG says so.
- **Files olcli writes for itself**: `.olcli.json`, the config file and `.olauth`. Newer versions read what older ones wrote, but not necessarily the other way around.
- **Internal modules**: anything imported from a path inside `dist/` instead of the package root.
- **The MCP tool descriptions and confirmation dialog texts**, which are for humans and models, not for parsing.

## Deprecation and breaking changes

- A breaking change to anything covered above ships only in a major release.
- At most one major release a year.
- Before a major release removes or changes something, at least one minor release prints a deprecation notice for it. For the command line that is one line per run on a terminal, naming the replacement; the old spelling keeps working until the major release. For the library it is a `@deprecated` tag in the type definitions and an entry in the CHANGELOG.
- Every deprecation is listed in the CHANGELOG of the release that introduces it, and in [CLI-CONVENTIONS.md](CLI-CONVENTIONS.md) for the command line.
- Security fixes may break covered behavior in a minor or patch release when there is no other way; the CHANGELOG then says so plainly.
