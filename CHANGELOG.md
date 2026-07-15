# Changelog

All notable changes to this project will be documented in this file.

## [0.8.0-experimental.0] - Unreleased

### Added

- Reusable real-time project/document session layer with acknowledged writes,
  timeouts, cleanup, redacted diagnostics, and separate ShareJS/history-OT
  adapters.
- Native tracked-change capability inspection, listing, targeted suggestions,
  and explicit-ID accept/reject commands.
- Durable comment-to-suggestion review workflow with a text-free local ledger,
  idempotent retry, reconciliation, and Git commit trailers.
- Read-only native Overleaf project-history listing, pagination, and file
  diffs through CLI, library, and MCP.
- Preview-first MCP review tools with `read`, `suggest`, and `full` policy
  modes, structured mutation preconditions, and stable errors.
- Unit, protocol-contract, fake-MCP integration, and disposable live E2E test
  coverage.
- Gated live coverage for stale-version refusal and comment anchors before,
  inside, and after a targeted tracked edit.
- Agent-ready README and `SKILL.md` instructions for the preconditioned
  comment-to-suggestion workflow.

### Fixed

- Absolute local upload paths now create a basename at the project root instead
  of reproducing host temporary directories remotely; safe relative nested
  paths remain nested.
- The legacy E2E harness carries local `.olauth` credentials into commands that
  change directories, exercises Git-remote mutations, and cleans up or verifies
  every synthetic remote file even after failures.

### Security and release changes

- Experimental tracked-review mutations require
  `OLCLI_EXPERIMENTAL_REVIEW=1` or the CLI `--experimental-review` flag.
- MCP Overleaf mutations default to read-only and older upload/comment/entity
  tools use the same policy gate.
- Verbose HTTP logging is redacted; raw protocol frames require an explicit
  unsafe flag.
- Fork package identity is `@xyin-anl/olcli` with the `experimental` npm tag.
  Publishing is manual, repository-scoped, and environment protected.
- Compatible transitive updates for `ajv`, `fast-uri`, and `undici` resolve
  the production dependency advisories present at the upstream baseline.

### Known limitations

- Undocumented Overleaf services may change without notice.
- `history-ot` mutation is contract-tested but not yet live-validated.
- Native history restoration and replay into Git are not supported.

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
