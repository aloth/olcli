# Changelog

All notable changes to this project will be documented in this file.

## [0.10.0] - 2026-09-03

### Added
- **`diff_project` MCP tool** - the MCP counterpart of `olcli diff`, so an assistant can preview what a push would change without shelling out to the CLI. Read-only: nothing is uploaded or written
  - Returns one entry per changed file with `path`, `status`, `binary` and a unified `patch`, rather than one block of diff text. The other 17 tools return JSON and an agent should be able to filter by status without parsing output
  - `name_only` drops the patch text, `file` restricts to one path, `context` sets hunk width, and both ignore switches mirror the CLI flags
  - Same semantics as the command: the remote is fetched fresh on every call and `remote_fetched_at` is part of the response, because a collaborator editing between the call and a later push can still change the outcome
  - Registration verified over a real MCP handshake rather than by reading the source: `tools/list` returns 18 tools including `diff_project`, with `project_id` and `local_dir` required
- **`olcli diff [project] [dir]`** ([#45](https://github.com/aloth/olcli/issues/45)) - content-level preview of what a push would change
  - `push --dry-run` answers *which files*; there was no way to see *what changed inside them* short of pulling into a scratch directory and running `diff(1)` by hand
  - Unified diff to stdout, colourized when stdout is a TTY. `--name-only` for paths only, `--file <path>` for a single file, `-U <n>` for context width
  - **The remote side is fetched fresh on every run**, and the command says so in `--help` and in its output footer. `.olcli.json` records remote *paths*, never remote *contents*, so there is no stored snapshot to compare against - "diff against the last pull" would have meant inventing a content cache, not reusing one. Fetching fresh is also what makes the diff describe what a subsequent `push` will overwrite, which is the question the command exists to answer
  - Cost of fetching fresh is one request: `downloadProject` returns the whole project as a single archive, the same call `pull` and `sync` already make. Per-file fetching would have been one request per file and still could not have identified which files differ without downloading them
  - `a/` is the remote and `b/` is local, so a `+` line is content `push` would upload and a `-` line is content it would overwrite
  - Binary files (PDFs, images) are reported as `Binary files ... differ`, detected by a NUL byte in the first 8000 bytes. No attempt is made to be cleverer
  - Both sides pass through the same ignore layers and the same dotfile rule. Filtering only the local side would have listed `output.pdf` and every stray `.aux` on Overleaf as a local deletion on every run
  - Remote-only files are reported but flagged as untouched by a plain `push`, since only `push --delete` removes them
  - Archive entries whose names escape the target directory are dropped, consistent with what `pull` refuses to extract
- **Continuous integration for pull requests** ([#46](https://github.com/aloth/olcli/issues/46))
  - The repository had no CI for pull requests. Only `publish.yml` existed, triggered by tags, so a change was first executed by a machine other than the author's at release time
  - `.github/workflows/ci.yml` runs `npm ci`, lint, build and test on pull requests and on pushes to `main`, across Node 20.18.1 and 24
  - A final step verifies `dist/cli.js`, `dist/mcp.js`, `dist/remote-helper.js` and `dist/index.js` are non-empty and that `node dist/cli.js --version` runs. `tsc` exiting zero does not prove entry points were emitted, and this is the step that caught the Node 18 breakage above on its first run
  - `test/e2e*.sh` are deliberately excluded: they drive a real Overleaf account
- **A working `npm run lint`.** The script had been defined since the initial release with no `eslint` in `devDependencies` and no configuration, so it failed on every clean install. Adds `eslint` 9 with `typescript-eslint`, flat config, no type-checked rules
  - `no-explicit-any` is a warning rather than an error. 58 pre-existing occurrences sit where untyped JSON comes back from Overleaf, which publishes no schema for those responses. As an error, CI would be red on `main` from the day it was switched on

### Changed
- Local file scanning extracted into `src/scan.ts`. `push` and `sync` each carried their own copy of the same walk-and-filter loop and the two had already drifted (`sync` guarded against a missing directory, `push` did not); `diff` would have made a third. Same reasoning as `src/rename-plan.ts` in 0.9.0
- `push --dry-run` now notes that its list is selected by modification time and points at `olcli diff` for content changes. The two commands answer different questions and will disagree - a file touched but not edited appears in `push --dry-run` and not in `diff` - so the overlap is resolved by making each one say what it measures rather than by merging them

### Fixed
- **`engines` claimed Node 18 support that did not exist.** olcli would not start at all on Node 18: `client.ts` imports `cheerio` at module load, `cheerio@1.2.0` depends on `undici@7.x`, and undici references `File` as a global, which Node only exposes from 20 onwards. The process died with `ReferenceError: File is not defined` before printing anything, including `--version`
  - Published 0.9.1 declared `engines: { node: ">=18" }` while its own lockfile resolved `cheerio 1.2.0` and `undici 7.20.0`, both declaring `>=20.18.1`. The manifest and the dependency tree contradicted each other
  - `engines` is now `>=20.18.1`, the exact floor every `undici` release in the `^7.19.0` range requires. Not `>=20`: the floor is a patch version, and rounding it down would restate the same kind of claim this release is fixing
  - Node 18 reached end of life on 2025-04-30. Pinning `cheerio` back to `~1.1.0` to keep it was considered and rejected: it freezes a dependency that would need manual attention on every future update, and its `undici@^7.10.0` range was never measured to actually work on 18
  - Verified against real Node 20.18.1 and 20.20.2 binaries, not against a version string: `npm ci`, lint, build, tests and `node dist/cli.js --version` all pass, and `dist/client.js` imports without error

### Internal
- Removed dead code the new lint setup surfaced: `printFolder` in `cli.ts`, unreachable since the initial 0.1.0 release and only ever calling itself; five imports that were pulled in and never referenced; twelve `catch (e)` clauses that never read the binding; three `let` bindings never reassigned. No behavior change
- `docs/MCP.md` and `SKILL.md` listed 15 and 17 MCP tools against 18 registered. `rename_project` and `plan_project_renames` had been missing since they were added; both files are now checked against the registrations rather than maintained by hand

### Notes
- New runtime dependency: [`diff`](https://www.npmjs.com/package/diff) `^9.0.0`, which has no dependencies of its own
- Comparison, rendering and remote-tree filtering live in `src/diff.ts` as pure functions, so they are unit-tested without an Overleaf account (`npm test`). Like `rename-plan.ts`, they are not re-exported from the package root
- `latexdiff` integration (`--latexdiff`, `--pdf`) is deliberately left out of this change and will follow separately

### Contributors
- [@Waynting](https://github.com/Waynting) - `olcli diff`, proposal and implementation ([#45](https://github.com/aloth/olcli/issues/45), [#48](https://github.com/aloth/olcli/pull/48))

## [0.9.1] - 2026-09-01

### Fixed
- **Zip-slip path traversal when extracting project archives** ([#44](https://github.com/aloth/olcli/pull/44), reported and fixed by [@Waynting](https://github.com/Waynting))
  - `pull` and `sync` joined each archive entry name onto the target directory with no validation, so an entry named `../../../../home/user/.bashrc` would be written outside the project directory
  - adm-zip's own `extractAllTo()` guards against this, but olcli extracts manually via `entry.getData()` and `writeFileSync()`, which bypasses it
  - This matters because olcli supports self-hosted Overleaf and ShareLaTeX instances, so the archive does not always come from a server the user controls or trusts
  - New `resolveWithin(baseDir, relativePath)` in `src/paths.ts` resolves a candidate path against the base directory and returns `null` unless the result is strictly inside it. Rejects `..` escapes, absolute paths, Windows drive letters, the base directory itself, and sibling-prefix cases where `/tmp/project-evil` string-prefixes `/tmp/project`
  - `pull` skips unsafe entries with a warning and excludes them from the `remoteManifest` written to `.olcli.json`, so they cannot enter deletion propagation on a later sync
  - `sync` filters them when building its remote file map and re-checks in the write loop
  - Well-formed archives are unaffected: safe entry names resolve to exactly the paths they did before

### Added
- `npm test` script running `test/paths.test.ts` via `node:test` and the existing `tsx` dev dependency. `publish.yml` already called `npm test --if-present`, which was a no-op until now, so this turns it into a real gate before publish. No new dependencies

## [0.9.0] - 2026-08-24

### Added
- **`olcli push --delete`** - opt-in propagation of local deletions to the remote
  - `push` has never removed remote files, so a file deleted locally stayed on Overleaf indefinitely. `sync` already handles this ([#7](https://github.com/aloth/olcli/issues/7)), but `sync` pulls the remote over the working tree first, which is not acceptable when the local tree is the source of truth
  - Deletion candidates come from `pushManifest` in `.olcli.json` (what this directory last uploaded), **never** from the remote listing - files uploaded by collaborators through the web editor are left alone
  - Skipped entirely when no baseline manifest exists (first push from a directory), since "deleted locally" and "never existed here" cannot be told apart
  - Deletions run *after* uploads, so a rename never leaves the remote without the file
  - Opt-in: default `push` behaviour is unchanged
- **`olcli project rename <newname> [project]`** - rename the project itself
  - `olcli rename` targets a doc/file/folder *inside* a project; there was no way to rename the project
  - `--dry-run` prints the change without applying it
  - Renaming to the current name is a no-op with an info message, not an error
- **`olcli project rename-bulk`** - pattern-based rename across many projects
  - Filters with `--match <regex>`, transforms with `--search`/`--replace`, `--prefix`, `--suffix`
  - **Dry-run is the default.** `--apply` is required to change anything - inverted from the usual convention because Overleaf keeps no project-name history, so a bulk rename fired on a typo cannot be undone
  - `--max <n>` refuses to apply when more than `n` projects would change
  - **Collision detection**: refuses to apply when two projects would end up with the same name, or when a target name is already taken by an untouched project. Overleaf tolerates duplicate names, so without this check the operation would succeed silently and leave projects that cannot be told apart in any listing
  - A failure mid-run is reported and the remaining renames continue; a partial run is recoverable by re-running, aborting midway would leave the same partial state with no report
- **MCP tool `rename_project`** - rename a project through the MCP surface
- **MCP tool `plan_project_renames`** - preview a bulk rename; returns planned renames, skipped projects and collisions
  - Deliberately plan-only. There is no apply counterpart on the MCP surface: an account-wide rename is unrecoverable, so applying a plan requires a human running `olcli project rename-bulk --apply`

### Changed
- Rename planning logic extracted into `src/rename-plan.ts` as a pure function, so the CLI and the MCP server evaluate the same rules. Two copies would drift, and the collision check is the part that must not

### Notes
- `.olcli.json` gains an optional `pushManifest` field. Older versions ignore unknown fields, so downgrading is safe. When no `pushManifest` exists, `push --delete` falls back to the `remoteManifest` written by `pull`

## [0.8.0] - 2026-08-08

### Added
- **Compile a specific `.tex` file as the root document** ([#38](https://github.com/aloth/olcli/pull/38)) - contributed by [@SomeBottle](https://github.com/SomeBottle)
  - New `-r, --resource <path>` option on `compile`, `pdf`, and `output`
  - Sets `rootResourcePath` on the Overleaf compile endpoint, so multi-document projects can build `appendix.tex`, a checklist document, or any other file independently
  - Useful for pulling a per-document `.bbl` when preparing arXiv bundles
  - MCP tools `compile`, `download_pdf`, and `compile_with_outputs` accept an optional `resource_path`
  - Clearer error when a compile fails and a resource path was given, hinting that the file may not exist in the project
  - E2E coverage for compile, PDF download, output listing, and log download with `--resource`
- **`--to <path>` option on `olcli upload`** ([#40](https://github.com/aloth/olcli/pull/40), closes [#39](https://github.com/aloth/olcli/issues/39)) to state the remote destination explicitly

### Fixed
- **Absolute paths passed to `olcli upload` no longer mirror the local directory structure into the project** ([#39](https://github.com/aloth/olcli/issues/39)) - reported by [@SomeBottle](https://github.com/SomeBottle) while working on #38
  - `/tmp/tmp.abc123/paper.tex` previously uploaded to `tmp/tmp.abc123/paper.tex`; it now lands in the project root as `paper.tex`
  - Relative paths are unchanged, so `figures/diagram.png` still lands in the `figures` folder
  - `.` and `..` segments are normalized, and paths that would escape the project root are collapsed rather than passed through
  - MCP `push_file` uses the same resolution for `remote_path`, so CLI and MCP agree
  - Path logic extracted into `src/paths.ts`

## [0.7.0] - 2026-07-02

### Added
- **Git remote helper** ([#36](https://github.com/aloth/olcli/issues/36)) — use Overleaf projects as native git remotes with `git clone overleaf::<url>`, `git push`, and `git pull`. Implements the `fast-import`/`fast-export` protocol with mark-based incremental tracking. New `git-remote-overleaf` binary registered in package. Originally proposed in [#15](https://github.com/aloth/olcli/pull/15) by [@bicheTortue](https://github.com/bicheTortue).
- Supports custom/self-hosted instances via URL: `git clone overleaf::https://overleaf.example.com/project/<id>`
- Auth via `OVERLEAF_SESSION` env var, `~/.olauth`, or stored config
- Debug mode via `GIT_REMOTE_OVERLEAF_DEBUG=1`

### Improved
- README restructured — extracted MCP docs to `docs/MCP.md` and git remote docs to `docs/GIT-REMOTE.md`
- Landing page (`docs/index.html`) updated with dynamic badges, git remote feature, and MCP section
- SKILL.md updated with git remote, MCP, comments, and "when to use which mode" decision table

## [0.6.0] - 2026-06-30

### Added
- **Configurable HTTP timeout** ([#35](https://github.com/aloth/olcli/pull/35), closes [#30](https://github.com/aloth/olcli/issues/30)) — contributed by [@rarensu](https://github.com/rarensu)
  - Global `--timeout` CLI option
  - `OVERLEAF_TIMEOUT` environment variable
  - `olcli config set-timeout` / `olcli config get-timeout` to persist
  - Precedence: flag > env > config > default (10000ms)
  - Fixes network timeouts for users behind proxies or with slow connections ([#29](https://github.com/aloth/olcli/issues/29))
- **Reply to comment threads** ([#34](https://github.com/aloth/olcli/pull/34), closes [#33](https://github.com/aloth/olcli/issues/33)) — contributed by [@rarensu](https://github.com/rarensu)
  - `olcli comments reply [project]`
  - New `reply_to_comment` MCP tool for AI agents
- **Password login for self-hosted instances** ([#32](https://github.com/aloth/olcli/pull/32)) — contributed by [@Li4nx](https://github.com/Li4nx)
  - `olcli auth --email --password ***`
  - Auto-refreshes expired sessions using stored credentials
  - `OverleafClient.fromPasswordLogin()` static factory method
  - MCP server automatically falls back to password login when cookie expires
  - Ideal for self-hosted Overleaf/ShareLaTeX without reCAPTCHA
- **Session cookie persistence improvements** ([#31](https://github.com/aloth/olcli/pull/31)) — contributed by [@Li4nx](https://github.com/Li4nx)
  - `getSessionCookiePair()` for robust cookie name detection
  - Credential persistence helpers exported via library API
  - Supports varied cookie names across Overleaf versions (`overleaf_session2`, `overleaf.sid`, `sharelatex.sid`)

### Contributors
- [@rarensu](https://github.com/rarensu) (Richard Lawrence) — timeout configuration, comment replies
- [@Li4nx](https://github.com/Li4nx) — password login, session persistence

## [0.5.0] - 2026-06-13

### Added
- **Library export** — olcli is now dual-use (CLI and importable library):
  ```ts
  import { OverleafClient } from '@aloth/olcli';
  const client = await OverleafClient.fromSessionCookie(cookie);
  ```
  All types and interfaces exported with full TypeScript declarations.
- **MCP server (Model Context Protocol)** — new `olcli-mcp` binary with 14 tools for AI agents (Claude Desktop, Cursor, Windsurf):
  - `list_projects`, `get_project_info`, `get_entities`
  - `pull_project`, `push_file`, `download_file`
  - `compile`, `download_pdf`, `compile_with_outputs`
  - `list_comments`, `add_comment`, `resolve_comment`
  - `delete_entity`, `rename_entity`

### No Breaking Changes
- CLI works identically to v0.4.1
- All existing scripts and workflows continue as-is

## [0.4.1] - 2026-06-12

### Fixed
- **PDF output selection** ([#26](https://github.com/aloth/olcli/issues/26), thanks [@drgmr](https://github.com/drgmr)!) — `olcli pdf` now correctly downloads the main compile output (`output.pdf`) instead of potentially picking up figure PDFs or `*-eps-converted-to.pdf` intermediates that appear earlier in the output file list.

## [0.4.0] - 2026-06-01

### Added
- **Review comment management** ([#25](https://github.com/aloth/olcli/pull/25)) — thanks [@shiquda](https://github.com/shiquda)! 🎉
  - `olcli comments list` — view comments with source file, line/column, selected text, messages, and optional context
  - `olcli comments add` — attach a comment to selected text or an explicit source range
  - `olcli comments resolve` / `reopen` / `delete` — manage comment threads
  - Supports `--status open|resolved|all`, `--context N`, and `--json` output
- **Nix flake** ([#24](https://github.com/aloth/olcli/issues/24)) — install via `nix profile install github:aloth/olcli`

## [0.3.1] - 2026-05-18

### Fixed
- **`olcli pdf` / `olcli output <type>` returned `Download failed: 404`** ([#22](https://github.com/aloth/olcli/issues/22)) — Overleaf's CDN now requires `?clsiserverid=<id>` on every build-output download. The compile response's `clsiServerId` is now appended to all output URLs.
- **`olcli upload figures/fig01.png` placed the file in project root** instead of inside `figures/`. The CLI now preserves the relative path, and the folder tree is loaded (and cached) on demand. Subfolders are auto-created if missing.
- **`olcli sync` upload pass** had the same subfolder bug — fixed by the same self-healing change.

### Added
- **Global `--verbose` flag** ([#21](https://github.com/aloth/olcli/issues/21)) — prints every HTTP request, status, content-type, and (on non-2xx) a snippet of the response body to stderr. Works before or after the command name.

### Internal
- New `OverleafClient.getOrLoadFolderTree(projectId)` / `invalidateFolderTree(projectId)` helpers with per-project caching.

## [0.3.0] - 2026-04-27

### ⚠ Behavior change
- `push` and `sync` now **filter local files through a built-in ignore list** before uploading to Overleaf. LaTeX build artifacts (`.aux`, `.bbl`, `.log`, `.out`, `.fls`, `.fdb_latexmk`, `.synctex.gz`, beamer/biber/glossaries/minted intermediates, etc.) and OS noise (`.DS_Store`, `Thumbs.db`, `*.swp`) are no longer uploaded.
  - **PDF special rule:** `X.pdf` is ignored only if a same-named `X.tex` (or `.ltx`) exists in the same folder.
  - To restore old behavior: `--no-default-ignore` or `--no-ignore`.

### Added
- `.olignore` file support — gitignore-style syntax for project-level ignore patterns. Negation (`!important.aux`) supported.
- `.olignore.local` file support — machine-specific patterns.
- `olcli ignored [dir]` — lists all ignore patterns in effect, grouped by source.
- `push --no-default-ignore` / `sync --no-default-ignore`
- `push --no-ignore` / `sync --no-ignore`
- `push --show-ignored` / `sync --show-ignored`

### Fixed
- [#19](https://github.com/aloth/olcli/issues/19) — `sync` no longer uploads LaTeX build artifacts that break Overleaf compile.

### Internal
- New module `src/ignore.ts` with `DEFAULT_IGNORE_PATTERNS`, `loadIgnore()`, `shouldIgnore()`, and `buildTexSiblingSet()`.
- New e2e test `test/e2e-ignore.sh` (31 assertions).

## [0.2.0] - 2026-04-27

### ⚠ Behavior change
- `sync` is now **destructive in both directions**: files deleted locally are propagated to the remote on the next sync.
  - On first run after upgrade, `sync` records a manifest of remote files in `.olcli.json`. From then on, any tracked file missing locally is deleted on Overleaf.
  - Use `sync --no-delete` to opt out per-run, or `sync --dry-run --verbose` to preview.

### Added
- `delete` / `rm` command — delete a file or folder by path
- `rename` / `mv` command — rename a file or folder by path
- `sync --no-delete` flag
- `.olcli.json` now stores a `manifest` field (used for deletion detection)

### Fixed
- [#7](https://github.com/aloth/olcli/issues/7) — `sync` no longer resurrects locally deleted files
- `getProjectInfo()` now falls back to the Socket.IO `joinProjectResponse` when Overleaf's HTML no longer ships the project tree in `<meta>` tags.
- `httpRequest()` now serializes `FormData` bodies properly.

### Internal
- New e2e test `test/e2e-issue7.sh` (22 assertions).

## [0.1.8] - 2026-04-17

### Fixed
- Replace `fetch` with a shared Node http/https client for Overleaf requests
- Fix ByteString/header failures caused by non-Latin1 response headers on additional request paths

## [0.1.7] - 2026-04-14

### Added
- Support for self-hosted Overleaf / ShareLaTeX instances
- Configurable `--base-url` and `--cookie-name`
- `olcli config set-url` / `olcli config get-url`
- `olcli config set-cookie-name` / `olcli config get-cookie-name`

### Improved
- Preserve folder structure when pushing nested files

### Fixed
- Generated `output.pdf` is no longer pushed back to Overleaf during `push` / `sync`

### Contributors
- [@admirkadriu](https://github.com/admirkadriu) — preserve folder structure when pushing files ([#3](https://github.com/aloth/olcli/pull/3))
- [@bicheTortue](https://github.com/bicheTortue) — README improvements ([#9](https://github.com/aloth/olcli/pull/9)), avoid re-uploading generated PDF ([#10](https://github.com/aloth/olcli/pull/10))
- [@Alice-space](https://github.com/Alice-space) — self-hosted Overleaf support ([#11](https://github.com/aloth/olcli/pull/11))

## [0.1.6] - 2026-03-18

### Fixed
- Fix ByteString error for projects with non-ASCII names ([#2](https://github.com/aloth/olcli/issues/2)) — binary downloads (`pull`, `pdf`, `output`) now use Node.js native `http`/`https` modules which don't have the Latin1 header restriction.

## [0.1.5] - 2026-02-19

### Fixed
- Root folder ID resolution now uses Overleaf's collaboration socket payload as authoritative source, fixing `push` failures (`folder_not_found`) ([#1](https://github.com/aloth/olcli/pull/1))
- `uploadFile()` now auto-retries once with a refreshed root folder ID when receiving `folder_not_found`

### Improved
- E2E tests are now portable across projects

### Contributors
- [@vicmcorrea](https://github.com/vicmcorrea) — first community contribution!

## [0.1.4] - 2026-02-06

### Changed
- Improved npm SEO with enhanced description and keywords
- Improved README for SEO and clarity

## [0.1.3] - 2026-02-05

### Fixed
- Folder resolution for imported Overleaf projects (`folder_not_found` errors)
- Trusted publishing workflow for npm

## [0.1.2] - 2026-02-03

### Added
- Demo GIF in README
- Dynamic version reading from package.json
