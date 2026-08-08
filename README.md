# olcli — Overleaf CLI

**Command-line interface for Overleaf** — Sync, manage, and compile LaTeX projects from your terminal.

[![npm version](https://img.shields.io/npm/v/@aloth/olcli.svg)](https://www.npmjs.com/package/@aloth/olcli)
[![npm downloads](https://img.shields.io/npm/dm/@aloth/olcli.svg)](https://www.npmjs.com/package/@aloth/olcli)
[![GitHub stars](https://img.shields.io/github/stars/aloth/olcli)](https://github.com/aloth/olcli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![AgentSkills](https://img.shields.io/badge/AgentSkills-compatible-blue)](https://agentskills.io)

Work with Overleaf projects directly from your command line. Edit locally with your favorite editor, version control with Git, and sync seamlessly with Overleaf's cloud compilation.

<p align="center">
  <img src="screenshots/demo.gif" alt="olcli demo" width="600">
</p>

## Features

- 📋 **List** all your Overleaf projects
- ⬇️ **Pull** project files to local directory for offline editing
- ⬆️ **Push** local changes back to Overleaf
- 🔄 **Sync** bidirectionally with smart conflict detection
- 🔀 **Git remote** — use Overleaf as a native git remote ([docs](docs/GIT-REMOTE.md))
- ✌️ **Two-way deletions** — files removed locally are deleted on Overleaf on next sync
- 🗑️ **Delete** and ✏️ **rename** remote files by path
- 🚫 **Smart ignore** — LaTeX build artifacts and OS noise filtered automatically; extend with `.olignore`
- 📄 **Compile** PDFs using Overleaf's remote compiler
- 📦 **Download** individual files or full project archives
- 📤 **Upload** files to projects
- 💬 **Review comments** — list, add, resolve, reopen, delete, and reply to threads
- 🗂️ **Preserve folder structure** when pushing nested files
- ⏱️ **Configurable timeout** for slow connections
- 🔑 **Password login** for self-hosted instances (no browser required)
- ⚙️ **Self-hosted Overleaf/ShareLaTeX** support
- 📊 **Output** compile artifacts (`.bbl`, `.log`, `.aux` for arXiv submissions)
- 🤖 **MCP server** for AI assistants ([docs](docs/MCP.md))

**Perfect for:**
- Editing LaTeX in your preferred text editor (Vim, VS Code, Emacs, etc.)
- Version control with Git while using Overleaf's compiler
- Automating workflows and CI/CD pipelines
- Offline work with periodic sync

## Installation

### Homebrew (macOS/Linux)

```bash
brew tap aloth/tap
brew install olcli
```

### npm (all platforms)

```bash
npm install -g @aloth/olcli
```

Or use with `npx` without installation:

```bash
npx @aloth/olcli list
```

### For AI agents (via AgentSkills)

```bash
npx skills add aloth/olcli
```

## Quick Start

### 1. Authenticate

**Session cookie** (overleaf.com and self-hosted):

```bash
olcli auth --cookie "your_session_cookie_value"
```

**Email/password** (self-hosted without reCAPTCHA):

```bash
olcli auth --email "you@example.com" --password "your_password"
```

### 2. List Projects

```bash
olcli list
```

### 3. Pull, Edit, Push

```bash
olcli pull "My Thesis"
cd My_Thesis/
vim main.tex
olcli push
```

### 4. Compile PDF

```bash
olcli pdf
# Compile a specific .tex file (for multi-doc projects):
olcli pdf -r appendix.tex
```

### 5. Or use native git commands

```bash
git clone overleaf::https://www.overleaf.com/project/<id>
cd <project>
# edit, commit, push — standard git workflow
git push
```

See [Git Remote Helper docs](docs/GIT-REMOTE.md) for details.

## Commands

All commands auto-detect the project when run from a synced directory (contains `.olcli.json`).

| Command | Description |
|---------|-------------|
| `olcli auth` | Set session cookie or login with email/password |
| `olcli whoami` | Check authentication status |
| `olcli logout` | Clear stored credentials |
| `olcli list` | List all projects |
| `olcli info [project]` | Show project details and file list |
| `olcli pull [project] [dir]` | Download project files to local directory |
| `olcli push [dir]` | Upload local changes to Overleaf |
| `olcli sync [dir]` | Bidirectional sync (pull + push) |
| `olcli upload <file> [project]` | Upload a single file (`--to <path>` sets the remote destination) |
| `olcli download <file> [project]` | Download a single file |
| `olcli delete <file> [project]` | Delete a remote file or folder (alias: `rm`) |
| `olcli rename <old> <new> [project]` | Rename a remote file or folder (alias: `mv`) |
| `olcli compile [project]` | Trigger PDF compilation |
| `olcli pdf [project]` | Compile and download PDF |
| `olcli output [type]` | Download compile output files |
| `olcli zip [project]` | Download project as zip archive |
| `olcli comments list [project]` | List comments (`--status`, `--context`) |
| `olcli comments add <file> <msg>` | Add a comment to selected text |
| `olcli comments reply <id> <body>` | Reply to a comment thread |
| `olcli comments resolve <id>` | Resolve a comment thread |
| `olcli comments reopen <id>` | Reopen a resolved thread |
| `olcli comments delete <id>` | Delete a comment thread |
| `olcli ignored [dir]` | List ignore patterns in effect |
| `olcli config set-url <url>` | Set self-hosted base URL |
| `olcli config set-cookie-name <name>` | Set session cookie name |
| `olcli config set-timeout <ms>` | Set default HTTP timeout |
| `olcli check` | Show config paths and credential sources |

### Compile Options

The compile-related commands (`compile`, `pdf`, `output`) accept:

| Flag | Description |
|------|-------------|
| `-r, --resource <path>` | Compile a specific `.tex` file as the root document (e.g. `appendix.tex`, `folder/test.tex`) |

Useful in multi-doc projects: each `-r` run compiles the file as if it were the main document.

### Global Options

| Flag | Description |
|------|-------------|
| `--verbose` | Print HTTP requests and responses to stderr |
| `--base-url <url>` | Override Overleaf instance URL |
| `--cookie-name <name>` | Override session cookie name |
| `--timeout <ms>` | Override HTTP timeout (default: 10000) |

## Sync Behavior

### Pull
- Downloads all files from Overleaf
- Skips local files modified after last pull (won't overwrite your changes)
- Use `--force` to overwrite local changes

### Push
- Uploads files modified after last pull
- Preserves nested folder structure
- Filters out LaTeX build artifacts and OS noise
- Use `--all` to upload all files, `--dry-run` to preview

### Sync
- Pulls remote changes, then pushes local changes
- Local modifications win if newer
- **Propagates local deletions** — use `--no-delete` to opt out
- Use `--dry-run` to preview without applying

#### How deletion propagation works

`olcli` records a manifest of remote files in `.olcli.json`. On next sync:

- File missing locally + still on remote → deleted on Overleaf
- File new locally → uploaded
- File modified locally → uploaded (local wins)
- File only on remote → downloaded

First-time syncs skip the deletion phase (no prior manifest to compare).

## Ignoring Files

### Three layers

| Layer | Source | Purpose |
|---|---|---|
| 1 | Built-in | LaTeX intermediates, OS noise, build dirs. Always on. |
| 2 | `.olignore` | Project-level patterns (gitignore syntax). |
| 3 | `.olignore.local` | Machine-specific patterns. |

Later layers override earlier ones. Negation (`!important.aux`) is supported.

### Special PDF rule

`X.pdf` is ignored only if `X.tex` (or `.ltx`) exists in the same folder.

### Inspecting and overriding

```bash
olcli ignored                  # list patterns in effect
olcli push --show-ignored      # see what was skipped
olcli sync --no-default-ignore # only .olignore applies
olcli sync --no-ignore         # upload everything
```

## Configuration

Credentials are checked in order:

1. `OVERLEAF_SESSION` environment variable
2. `.olauth` file in current directory
3. Global config: `~/.config/olcli-nodejs/config.json`

### Self-hosted Overleaf

```bash
olcli config set-url https://latex.example.org
olcli config set-cookie-name overleaf.sid
```

Or pass per-command: `olcli --base-url https://latex.example.org list`

### Timeout

```bash
olcli config set-timeout 60000          # persist
olcli --timeout 60000 pull "Big Thesis" # one-off
export OVERLEAF_TIMEOUT=60000           # env var
```

Precedence: `--timeout` > `OVERLEAF_TIMEOUT` > config > default (10000ms).

## Examples

```bash
# Daily thesis workflow
olcli pull "PhD Thesis" thesis && cd thesis
vim chapters/methods.tex
olcli sync && olcli pdf -o draft.pdf

# Quick PDF download
olcli pdf "Conference Paper" -o paper.pdf

# Compile a specific root document
olcli pdf "Conference Paper" -r appendix.tex -o appendix.pdf
olcli compile "Conference Paper" -r folder/test.tex

# Upload figures
olcli upload figures/diagram.png          # relative path is preserved
olcli upload /tmp/build/diagram.png       # absolute path lands in the project root
olcli upload /tmp/build/diagram.png --to figures/diagram.png   # explicit destination

# arXiv submission prep
olcli output bbl -o main.bbl
olcli output bbl -r folder/test.tex -o main.bbl  # compile artifacts from a specific root doc
olcli zip -o arxiv-submission.zip

# Backup all projects
for proj in $(olcli list --json | jq -r '.[].name'); do
  olcli zip "$proj" -o "backups/${proj}.zip"
done
```

## Programmatic Usage (Library API)

`@aloth/olcli` exposes `OverleafClient` and all public interfaces as a library.

### Install

```bash
npm install @aloth/olcli
```

### Basic example

```ts
import { OverleafClient } from '@aloth/olcli';

const client = await OverleafClient.fromSessionCookie(cookie);

const projects = await client.listProjects();
const info = await client.getProjectInfo(projectId);
const zipBuf = await client.downloadProject(projectId);
const pdfBuf = await client.downloadPdf(projectId);

await client.uploadFile(projectId, null, 'main.tex', readFileSync('main.tex'));

const comments = await client.listComments(projectId, { status: 'open' });
```

### Available exports

```ts
import {
  OverleafClient,
  // Types
  Project, ProjectInfo, FolderEntry, DocEntry, FileEntry,
  CommentMessage, ProjectComment, CommentContext, CommentStatus,
  ListCommentsOptions, AddCommentOptions, Credentials, SessionCookiePair,
  // Config utilities
  getBaseUrl, setBaseUrl, getSessionCookie, setSessionCookie,
  getSessionCookieName, setSessionCookieName, getCsrf, setCsrf,
  getLastProject, setLastProject, clearConfig, getConfigPath, saveOlAuth,
  getTimeout, setTimeout, getPasswordCredentials, setPasswordCredentials,
  clearPasswordCredentials, type PasswordCredentials,
  // Ignore utilities
  DEFAULT_IGNORE_PATTERNS, loadIgnore, shouldIgnore, buildTexSiblingSet,
  IgnoreContext, LoadIgnoreOptions,
} from '@aloth/olcli';
```

## Further Documentation

- [MCP Server](docs/MCP.md) — AI assistant integration (Claude, Cursor, Windsurf)
- [Git Remote Helper](docs/GIT-REMOTE.md) — use Overleaf as a native git remote

## Troubleshooting

**Session expired** — Get a fresh cookie from the browser and run `olcli auth` again.

**Compilation fails** — Check the Overleaf web editor for detailed error logs (missing packages, syntax errors, missing bibliography files).

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT © [Alexander Loth](https://alexloth.com)
