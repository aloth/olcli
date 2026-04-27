# Changelog

All notable changes to this project will be documented in this file.

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
