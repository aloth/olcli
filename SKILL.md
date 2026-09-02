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

`compile`, `download_pdf` and `compile_with_outputs` accept an optional `resource_path` to compile a specific root document.

Auth: set `OVERLEAF_SESSION` env var in MCP config, or use stored credentials from `olcli auth`.

## Common Workflows

### Pull a project to work locally

```bash
olcli pull "My Paper"
cd My_Paper/
```

### Create a project

```bash
olcli project create "My Paper"
olcli project create "Example Paper" --template example
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
olcli pdf -r chapters/intro.tex  # Compile a specific root document
olcli compile                  # Just compile (no download)
olcli compile -r appendix.tex  # Compile a specific root document without downloading
```

`-r, --resource <path>` works on `compile`, `pdf`, and `output`: it compiles the given `.tex` file as the root document. Useful when a project contains several documents.  

### Download .bbl for arXiv submission

```bash
olcli output bbl               # Download compiled .bbl
olcli output bbl -o main.bbl   # Custom filename
olcli output bbl -r appendix.tex
olcli output --list            # List all available outputs
```

### Upload figures or assets

```bash
olcli upload figure1.png "My Paper"          # Upload to project root
olcli upload diagram.pdf                      # Auto-detect project from .olcli.json
olcli upload figures/diagram.png              # Relative path is preserved remotely
olcli upload /tmp/build/diagram.png           # Absolute path lands in the project root
olcli upload /tmp/build/diagram.png --to figures/diagram.png   # Explicit destination
```

Remote path rules: a relative local path keeps its directory part, an absolute
local path collapses to its basename, and `--to` overrides both.

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
| `olcli project create <name>` | Create a blank or example project |
| `olcli info [project]` | Show project details |
| `olcli pull [project] [dir]` | Download project files |
| `olcli push [dir]` | Upload local changes |
| `olcli sync [dir]` | Bidirectional sync |
| `olcli upload <file> [project]` | Upload a single file (`--to <path>` sets the remote destination) |
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
