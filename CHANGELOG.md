# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added
- **Review comment management** — new `olcli comments` commands to list Overleaf review comments with source locations and optional context, add comments to selected document text, resolve/reopen comment threads, and permanently delete comment threads.

## [0.3.1] - 2026-05-18

### Fixed
- **`olcli pdf` / `olcli output <type>` returned `Download failed: 404`** (#22) — Overleaf's CDN now requires `?clsiserverid=<id>` on every build-output download. We were stripping that hint. The compile response's `clsiServerId` field is now appended to all output URLs (`pdf`, `bbl`, `log`, `aux`, …).
- **`olcli upload figures/fig01.png` placed the file in project root** instead of inside `figures/`. The CLI previously called `basename()` on the path and never resolved the folder tree. Now the relative path is preserved and the folder tree is loaded (and cached) on demand. Subfolders are auto-created if missing.
- **`olcli sync` upload pass** also dropped subfolder information when pushing local-newer files. Same fix as above (`uploadFile` now self-resolves the folder tree when the caller doesn't pass one).

### Added
- **Global `--verbose` flag** (#21) — prints every HTTP request, status, content-type, and (on non-2xx) a 200-char snippet of the response body to stderr. Use as `olcli --verbose pdf` or `olcli pdf --verbose` for troubleshooting failed compiles, uploads, or auth.

### Internal
- New `OverleafClient.getOrLoadFolderTree(projectId)` / `invalidateFolderTree(projectId)` helpers with per-project caching, so callers no longer have to plumb a `folderTree` argument through every code path.

## [0.3.0] - 2026-04-27

### ⚠ Behavior change
- `push` and `sync` now **filter local files through a built-in ignore list** before uploading to Overleaf. LaTeX build artifacts (`.aux`, `.bbl`, `.log`, `.out`, `.fls`, `.fdb_latexmk`, `.synctex.gz`, beamer/biber/glossaries/minted intermediates, etc.) and OS noise (`.DS_Store`, `Thumbs.db`, `*.swp`) are no longer uploaded.
  - Previously, locally compiling a project (e.g. with `pdflatex` or `latexmk`) would upload dozens of build artifacts to Overleaf, which could break Overleaf's own compile (stale `.aux` / `.bbl`) or pollute the remote project.
  - **PDF special rule:** `X.pdf` is ignored only if a same-named `X.tex` (or `.ltx`) exists in the same folder. Hand-uploaded `figures/diagram.pdf` is still synced.
  - To restore the old behavior on a per-run basis, use `--no-default-ignore` (only respects `.olignore`) or `--no-ignore` (uploads everything).

### Added
- **`.olignore` file support** — gitignore-style syntax for project-level ignore patterns. Negation (`!important.aux`) is supported.
- **`.olignore.local` file support** — machine-specific patterns that should not be committed to version control.
- **`olcli ignored [dir]`** command — lists all ignore patterns currently in effect for a project, grouped by source.
- `push --no-default-ignore` / `sync --no-default-ignore` — disable built-in defaults (only `.olignore` applies).
- `push --no-ignore` / `sync --no-ignore` — disable all ignore filtering (escape hatch).
- `push --show-ignored` / `sync --show-ignored` — print files that were skipped by ignore rules.
- New dependency: [`ignore`](https://www.npmjs.com/package/ignore) (~30KB, zero deps, gitignore-compatible matcher used by ESLint/Prettier).

### Fixed
- **#19** — `sync` no longer uploads LaTeX build artifacts, breaking Overleaf compile.

### Internal
- New module `src/ignore.ts` with `DEFAULT_IGNORE_PATTERNS`, `loadIgnore()`, `shouldIgnore()`, and `buildTexSiblingSet()`.
- New e2e test `test/e2e-ignore.sh` covering defaults, `.olignore`, `.olignore.local`, negation, the PDF sibling rule, and the `--no-*` escape hatches.


## [0.2.0] - 2026-04-27

### ⚠ Behavior change
- `sync` is now **destructive in both directions**: files deleted locally are propagated to the remote on the next sync, just like remote deletions are propagated locally.
  - On first run after upgrade, `sync` records a manifest of remote files in `.olcli.json`. From then on, any tracked file missing locally is deleted on Overleaf.
  - Use `sync --no-delete` to opt out per-run, or `sync --dry-run --verbose` to preview deletions before applying.
  - **If you have stale local checkouts where you intentionally removed files, those files will be deleted from Overleaf on the next sync.** Pull a fresh copy or use `--no-delete` if unsure.

### Added
- `delete` / `rm` command — delete a file or folder from a project by path
- `rename` / `mv` command — rename a file or folder in a project by path
- `sync --no-delete` flag — skip the deletion-propagation phase
- `.olcli.json` now stores a `manifest` field listing remote files at last sync (used for deletion detection)

### Fixed
- **#7** — `sync` no longer resurrects locally deleted files. Previously the pull phase silently restored every remote file before the push phase ran, so local deletions were never propagated.
- `getProjectInfo()` now falls back to the Socket.IO `joinProjectResponse` when Overleaf's HTML page no longer ships the project tree in `<meta>` tags. This was silently breaking `findEntityByPath`, `deleteByPath`, and `renameByPath`.
- `httpRequest()` now serializes `FormData` bodies properly. The 0.1.7 fetch→node-http refactor passed `FormData` straight to `req.write()`, breaking every file upload (`The "chunk" argument must be of type string or an instance of Buffer`).

### Internal
- Re-enabled previously commented-out `delete`/`rename` CLI blocks. The blocking concern (no entity-id resolution) was already solved by `findEntityByPath` / `deleteByPath` / `renameByPath` in `src/client.ts`.
- New e2e test `test/e2e-issue7.sh` covers delete, rename, sync-after-deletion, and `--no-delete` flag (22 assertions).


## [0.1.5] - 2026-02-19

### Fixed
- Root folder ID resolution now uses Overleaf's collaboration socket payload as authoritative source, fixing `push` failures (`folder_not_found`) for projects where HTML parsing and ObjectID arithmetic both return incorrect IDs ([#1](https://github.com/aloth/olcli/pull/1))
- `uploadFile()` now auto-retries once with a refreshed root folder ID when receiving `folder_not_found`

### Improved
- E2E tests are now portable across projects (configurable project name, no `main.tex` assumption, optional `.bbl` check)
- Added regression test for stale cached `rootFolderId`

### Contributors
- @vicmcorrea — first community contribution!

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
