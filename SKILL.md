---
name: overleaf
description: Sync and manage Overleaf LaTeX projects from the command line. Pull projects locally, push changes back, compile PDFs, and download compile outputs like .bbl files for arXiv submissions. Use when working with LaTeX, Overleaf, academic papers, or arXiv.
license: MIT
metadata:
  author: aloth
  version: "1.3"
  cli: olcli
  install: brew tap aloth/tap && brew install olcli
---

# Overleaf Skill

Manage Overleaf LaTeX projects via the `olcli` CLI, native git remote, or MCP server.

## When to Use Which Mode

| Mode | Best for | How |
|------|----------|-----|
| **CLI** (`olcli`) | Interactive workflows, sync, compile, arXiv prep | `olcli pull/push/sync/pdf` |
| **Git remote** | Version control, commits, diffs, CI/CD pipelines | `git clone overleaf::…` then standard git |
| **MCP server** | AI agents with MCP support (Claude, Cursor, Windsurf) | Connect via `olcli-mcp` stdio transport |

Use **CLI** when you need bidirectional sync with conflict detection, compilation, or comment management. Use **Git remote** when you want proper git history, branches, and standard `git push/pull`. Use **MCP** when an AI agent has native MCP support and doesn't need to shell out.

## Installation

```bash
# Homebrew (recommended)
brew tap aloth/tap && brew install olcli

# npm
npm install -g @aloth/olcli
```

## Authentication

Get your session cookie from Overleaf:

1. Log into [overleaf.com](https://www.overleaf.com)
2. Open DevTools (F12) → Application → Cookies
3. Copy the value of `overleaf_session2`

```bash
olcli auth --cookie "YOUR_SESSION_COOKIE"
```

Verify with:
```bash
olcli whoami
```

Debug authentication issues:
```bash
olcli check
```

Clear stored credentials:
```bash
olcli logout
```

### Self-hosted Overleaf

```bash
olcli config set-url https://overleaf.yourcompany.com
olcli config set-cookie-name overleaf.sid   # if different from default
olcli auth --cookie "YOUR_COOKIE"
```

Or pass per-command: `olcli --base-url https://overleaf.yourcompany.com list`

## Git Remote Helper

Use Overleaf projects as native git remotes. No wrapper scripts needed.

```bash
# Clone
git clone overleaf::https://www.overleaf.com/project/<id>
cd <project>

# Edit, commit, push — standard git workflow
vim main.tex
git add . && git commit -m "update introduction"
git push

# Pull latest from Overleaf
git pull
```

Authentication: reads `OVERLEAF_SESSION` env var, `~/.olauth` file, or stored config (same as CLI).

For self-hosted instances, just use your instance URL:
```bash
git clone overleaf::https://overleaf.yourcompany.com/project/<id>
```

Debug with: `GIT_REMOTE_OVERLEAF_DEBUG=1 git push`

## MCP Server

Built-in Model Context Protocol server for AI assistant integration.

```bash
# Run standalone
olcli-mcp

# Or via npx
npx @aloth/olcli-mcp
```

Available MCP tools: `list_projects`, `get_project_info`, `pull_project`, `push_file`, `compile`, `download_pdf`, `list_comments`, `get_entities`, `download_file`, `add_comment`, `reply_to_comment`, `resolve_comment`, `delete_entity`, `rename_entity`, `compile_with_outputs`.

Auth: set `OVERLEAF_SESSION` env var in MCP config, or use stored credentials from `olcli auth`.

## Common Workflows

### Pull a project to work locally

```bash
olcli pull "My Paper"
cd My_Paper/
```

### Edit and sync changes

```bash
# After editing files locally
olcli push              # Upload changes only
olcli sync              # Bidirectional sync (pull + push, propagates local deletions)
olcli sync --no-delete  # Sync without propagating local deletions to remote
```

### Delete or rename remote files

```bash
olcli delete chapters/old.tex          # remove a file from the project
olcli rm figures/old.pdf               # alias
olcli rename old.tex new.tex           # rename a file
olcli mv chapters/draft.tex chapters/intro.tex   # alias
```

### Inspect ignore rules

```bash
olcli ignored              # list active patterns (built-ins + .olignore + .olignore.local)
olcli push --show-ignored  # see what was filtered on this run
olcli sync --no-ignore     # escape hatch: upload everything
```

### Compile and download PDF

```bash
olcli pdf                      # Compile and download
olcli pdf -o paper.pdf         # Custom output name
olcli compile                  # Just compile (no download)
```

### Download .bbl for arXiv submission

```bash
olcli output bbl               # Download compiled .bbl
olcli output bbl -o main.bbl   # Custom filename
olcli output --list            # List all available outputs
```

### Upload figures or assets

```bash
olcli upload figure1.png "My Paper"          # Upload to project root
olcli upload diagram.pdf                      # Auto-detect project from .olcli.json
```

### Download specific files

```bash
olcli download main.tex "My Paper"           # Download single file
olcli zip "My Paper"                          # Download entire project as zip
```

### Review comments

```bash
olcli comments list                          # List all comments (current project)
olcli comments list --status open            # Filter by status (open/resolved/all)
olcli comments list --context                # Include surrounding text
olcli comments add main.tex "Fix this citation" --from 10 --to 15  # Add comment
olcli comments reply <thread-id> "Done!"     # Reply to thread
olcli comments resolve <thread-id>           # Mark as resolved
olcli comments reopen <thread-id>            # Reopen a resolved thread
olcli comments delete <thread-id>            # Delete entire thread
```

## arXiv Submission Workflow

Complete workflow for preparing an arXiv submission:

```bash
# 1. Pull your project
olcli pull "Research Paper"
cd Research_Paper

# 2. Compile to ensure everything builds
olcli compile

# 3. Download the .bbl file (arXiv requires .bbl, not .bib)
olcli output bbl -o main.bbl

# 4. Download any other needed outputs
olcli output aux -o main.aux    # If needed

# 5. Package for submission
zip arxiv.zip *.tex main.bbl figures/*.pdf

# 6. Verify the package compiles locally (optional)
# Then upload arxiv.zip to arxiv.org
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `olcli auth --cookie <value>` | Authenticate with session cookie |
| `olcli auth --email <e> --password <p>` | Authenticate with password (self-hosted) |
| `olcli whoami` | Check authentication status |
| `olcli logout` | Clear stored credentials |
| `olcli check` | Show config paths and credential sources |
| `olcli list` | List all projects |
| `olcli info [project]` | Show project details |
| `olcli pull [project] [dir]` | Download project files |
| `olcli push [dir]` | Upload local changes |
| `olcli sync [dir]` | Bidirectional sync |
| `olcli upload <file> [project]` | Upload a single file |
| `olcli download <file> [project]` | Download a single file |
| `olcli delete <file> [project]` | Delete a remote file or folder (alias: `rm`) |
| `olcli rename <old> <new> [project]` | Rename a remote file or folder (alias: `mv`) |
| `olcli ignored [dir]` | List active ignore patterns |
| `olcli zip [project]` | Download as zip archive |
| `olcli compile [project]` | Trigger compilation |
| `olcli pdf [project]` | Compile and download PDF |
| `olcli output [type]` | Download compile outputs |
| `olcli comments list [project]` | List review comments |
| `olcli comments add <file> <msg>` | Add a comment |
| `olcli comments reply <id> <body>` | Reply to a thread |
| `olcli comments resolve <id>` | Resolve a thread |
| `olcli comments reopen <id>` | Reopen a thread |
| `olcli comments delete <id>` | Delete a thread |
| `olcli config set-url <url>` | Set self-hosted base URL |
| `olcli config set-cookie-name <name>` | Set cookie name |
| `olcli config set-timeout <ms>` | Set HTTP timeout |

## Tips

- **Auto-detect project**: Run commands from a synced directory (contains `.olcli.json`) to skip the project argument
- **Dry run**: Use `olcli push --dry-run` or `olcli sync --dry-run` to preview before applying
- **Force overwrite**: Use `olcli pull --force` to overwrite local changes
- **Two-way deletes**: `olcli sync` propagates *local* deletions to the remote; use `--no-delete` to opt out per run
- **Build artifacts**: `.aux`, `.bbl`, `.log`, `.synctex.gz` etc. are filtered by default. Add custom patterns to a `.olignore` file (gitignore-style)
- **PDF rule**: `thesis.pdf` next to `thesis.tex` is auto-ignored; standalone `figures/diagram.pdf` is preserved
- **Project ID**: You can use project ID instead of name (24-char hex from URL)
- **Debug auth**: Run `olcli check` to see where credentials are loaded from
- **Timeout**: `olcli --timeout 60000 pull "Big Project"` or `olcli config set-timeout 60000`

## Native Review Automation

Use the MCP tools for agent-driven review. Use the CLI for interactive setup,
diagnostics, and Git workflows. Treat the Overleaf session cookie as a
password.

### Prepare the local checkout

The experimental npm package is not published yet. Run from this repository:

```bash
cd /absolute/path/to/olcli
npm ci
npm run build
```

Replace `/absolute/path/to/olcli` with this checkout's absolute path.

Keep `.olauth` gitignored at mode `0600`, or provide `OVERLEAF_SESSION` through
a protected MCP environment. Never print credentials or enable raw protocol
logging on a real manuscript.

Start MCP from the repository root so local authentication and the review
ledger resolve predictably:

```bash
OLCLI_EXPERIMENTAL_REVIEW=1 \
OLCLI_MCP_REVIEW_MODE=suggest \
node dist/mcp.js
```

Use `read` for inspection only, `suggest` for tracked suggestions and replies,
and `full` only when the user explicitly authorizes accept/reject, comment
resolution, uploads, renames, or deletion.

### Address an open comment

Follow this sequence for every comment. Do not collapse or reorder mutation
steps.

1. Call `get_mcp_review_policy`. Require `suggestTrackedChanges: true`.
2. Call `list_comments` with:

   ```json
   {"project_id":"<id>","status":"open","include_context":true}
   ```

3. Select one comment and call `get_changes_capabilities` with its document
   path. Stop unless `canSuggest` is true.
4. Choose the smallest exact `old_text` → `new_text` replacement that addresses
   the comment and overlaps its selected range. Preserve LaTeX structure.
5. Call `preview_tracked_change`. If the source match is stale or ambiguous,
   stop and ask for direction or make the target more precise.
6. Generate one stable UUID for the operation. Call `address_review_comment`
   with:

   - the same project, thread, path, old text, and new text;
   - `expected_version` from preview `version`;
   - `expected_text_sha256` from preview `textSha256`;
   - the stable `operation_id`;
   - `resolution_policy: "never"`;
   - `allow_unrelated: false`;
   - `dry_run: true`.

7. Check that the linked preview targets the intended comment and path.
8. Repeat `address_review_comment` with the same values and
   `dry_run: false`.
9. Require `verified: true`, `trackChangesStateRestored: true`, non-empty
   change IDs, and a posted reply.
10. Call `compile`, then `list_tracked_changes` for the document. Confirm every
    returned change ID exists.
11. Leave the comment open and leave accept/reject to collaborators.

Reuse the same `operation_id` only to resume the exact same request after a
partial failure. Never reuse it for different text or a different thread.

### Mutation rules

- Never use `push_file`, `olcli push`, or `olcli sync` for reviewer-facing
  edits. Those are full-file operations and do not create native tracked
  suggestions.
- Never weaken or omit version/hash preconditions after a conflict.
- Never retry automatically after an uncertain acknowledgment. Re-list state
  or run reconciliation first.
- Never resolve a comment by default. Keep `resolution_policy: "never"` unless
  the user explicitly grants resolution authority and enables `full` mode.
- Never accept or reject all changes implicitly. Use explicit native IDs.
- Keep edits small. Avoid delete-all/reinsert-all operations.
- Compile after mutations and report verification failures visibly.

### Accept or reject changes

Use only in explicitly authorized `full` mode.

1. Call `list_tracked_changes` and select explicit IDs.
2. Call `inspect_tracked_document` for the current text-free `version` and
   `textSha256`.
3. Call `accept_tracked_changes` or `reject_tracked_changes` with those
   preconditions and `dry_run: true`.
4. Review the exact IDs, change kinds, text, and expected result hash.
5. Repeat with `dry_run: false`.
6. Require `verified: true`, re-list changes, and compile.

### Reconcile and audit

- Use `review_status` to inspect the text-free `.olcli-review.json` ledger.
- Use `reconcile_review` with `dry_run: true` by default.
- Require `full` mode and explicit user authority before reconciliation writes
  or automatic comment resolution.
- Keep Git as the durable audit and rollback record. Overleaf history versions
  are not Git commits or document OT versions.

### Inspect history

Use `list_history` for normalized native update groups. Follow `nextBefore` as
the `before` cursor. Use `diff_history` with `include_content: false` unless the
task genuinely requires inserted/deleted source text. History restoration and
replay into Git are not supported.

### CLI fallback

Use these commands for diagnostics or when MCP is unavailable:

```bash
olcli comments list "Paper" --status open --context 3 --json
olcli changes doctor "Paper" --file main.tex
olcli changes list "Paper" --file main.tex --json
olcli changes suggest main.tex "Paper" \
  --old "Exact old text" --new "Exact new text" --dry-run --json
OLCLI_EXPERIMENTAL_REVIEW=1 olcli changes suggest main.tex "Paper" \
  --old "Exact old text" --new "Exact new text" \
  --expected-version <version> --expected-sha256 <sha256> --json
olcli compile "Paper"
```

### Read detailed references only when needed

- Read [docs/MCP.md](docs/MCP.md) for tool schemas and MCP client setup.
- Read [docs/REVIEW-WORKFLOW.md](docs/REVIEW-WORKFLOW.md) for ledger states,
  recovery, and comment-resolution policies.
- Read [docs/TRACKED-CHANGES.md](docs/TRACKED-CHANGES.md) for OT adapters and
  tracked-change semantics.
- Read [docs/HISTORY.md](docs/HISTORY.md) for pagination and diff behavior.
- Read [docs/PROTOCOL-COMPATIBILITY.md](docs/PROTOCOL-COMPATIBILITY.md) before
  using a document that reports `history-ot`.
- Read [SECURITY.md](SECURITY.md) before enabling `full` mode or unsafe logs.
