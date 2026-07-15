# olcli — experimental tracked-review fork

**Command-line interface for Overleaf** — Sync, manage, and compile LaTeX projects from your terminal.

[![GitHub](https://img.shields.io/badge/GitHub-xyin--anl%2Folcli-blue)](https://github.com/xyin-anl/olcli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![AgentSkills](https://img.shields.io/badge/AgentSkills-compatible-blue)](https://agentskills.io)

Work with Overleaf projects directly from your command line. Edit locally with your favorite editor, version control with Git, and sync seamlessly with Overleaf's cloud compilation.

> This is an experimental fork of
> [`aloth/olcli`](https://github.com/aloth/olcli) focused on native Overleaf
> tracked changes, comments, read-only history, and safe agent workflows. It
> relies on undocumented services; keep Git backups and start with disposable
> projects.

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
- 📝 **Native tracked review** — inspect changes and create small, preconditioned suggestions
- 🔗 **Comment-to-change workflow** — suggest, reply, reconcile, and link Git metadata without full-file rewrites
- 🕰️ **Read-only project history** — list native update groups and diff files between versions
- 🗂️ **Preserve folder structure** when pushing nested files
- ⏱️ **Configurable timeout** for slow connections
- 🔑 **Password login** for self-hosted instances (no browser required)
- ⚙️ **Self-hosted Overleaf/ShareLaTeX** support
- 📊 **Output** compile artifacts (`.bbl`, `.log`, `.aux` for arXiv submissions)
- 🤖 **MCP server** for AI assistants ([docs](docs/MCP.md))
- 🛡️ **Preview-first MCP policy** — `read`, `suggest`, and explicit `full` mutation modes

**Perfect for:**
- Editing LaTeX in your preferred text editor (Vim, VS Code, Emacs, etc.)
- Version control with Git while using Overleaf's compiler
- Automating workflows and CI/CD pipelines
- Offline work with periodic sync

## Installation

### Current local checkout

```bash
cd /path/to/olcli
npm ci
npm run build
npm link
```

Do not install upstream and the fork globally at the same time because both
provide the `olcli`, `olcli-mcp`, and `git-remote-overleaf` executables.

The fork has not been published to npm yet. After its first approved release,
the intended installation command will be:

```bash
npm install -g @xyin-anl/olcli@experimental
```

### Upstream stable release

```bash
brew tap aloth/tap
brew install olcli
```

The Homebrew formula installs upstream and does not include this fork's review
features.

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
```

### 5. Or use native git commands

```bash
git clone overleaf::https://www.overleaf.com/project/<id>
cd <project>
# edit, commit, push — standard git workflow
git push
```

See [Git Remote Helper docs](docs/GIT-REMOTE.md) for details.

## Agent quick start

Point an agent to this section and [SKILL.md](SKILL.md). The detailed MCP tool
schemas and client configuration are in [docs/MCP.md](docs/MCP.md).

### Start the local MCP server

Keep the server working directory at the repository root so it can read the
gitignored `.olauth` file:

```bash
cd /absolute/path/to/olcli
OLCLI_EXPERIMENTAL_REVIEW=1 \
OLCLI_MCP_REVIEW_MODE=suggest \
node dist/mcp.js
```

Equivalent stdio MCP configuration for the current local checkout:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "zsh",
      "args": [
        "-lc",
        "cd /absolute/path/to/olcli && exec node dist/mcp.js"
      ],
      "env": {
        "OLCLI_EXPERIMENTAL_REVIEW": "1",
        "OLCLI_MCP_REVIEW_MODE": "suggest"
      }
    }
  }
}
```

Replace `/absolute/path/to/olcli` with this checkout's absolute path.

Use `suggest` for the normal collaborator-review workflow. It permits native
tracked suggestions and replies, while blocking accept/reject, resolution,
uploads, renames, and deletes.

### Required agent workflow

For each open comment:

1. Call `get_mcp_review_policy`; require `suggestTrackedChanges: true`.
2. Call `list_comments` with `status: "open"` and
   `include_context: true`.
3. Call `get_changes_capabilities` for the comment's document; stop unless
   `canSuggest` is true.
4. Choose one small exact replacement that overlaps the selected comment
   range. Do not rewrite or upload the whole file.
5. Call `preview_tracked_change` with the exact `old_text` and `new_text`.
6. Pass the preview's `version` and `textSha256` to
   `address_review_comment` as `expected_version` and
   `expected_text_sha256`. Use a stable UUID `operation_id`,
   `resolution_policy: "never"`, and `dry_run: true`.
7. Review the preview. Then repeat `address_review_comment` with the same
   values and `dry_run: false`.
8. Require `verified: true` and `trackChangesStateRestored: true`, compile,
   re-list the returned change IDs, and confirm the comment reply exists.
9. Leave acceptance, rejection, and comment resolution to collaborators unless
   the user explicitly authorizes `full` mode.

If the source version/hash changes, the match becomes ambiguous, or the
protocol result is uncertain, stop and preview again. Never automatically
retry a mutation with weakened preconditions. Do not use `push_file`, `push`,
or `sync` for reviewer-facing tracked edits.

Useful read-only follow-up tools are `review_status`, `reconcile_review` with
`dry_run: true`, `list_history`, and `diff_history` with
`include_content: false`.

In explicitly authorized `full` mode, call `inspect_tracked_document` before
previewing `accept_tracked_changes` or `reject_tracked_changes`; pass its
`version` and `textSha256` as the required preconditions. Always use explicit
change IDs and preview the resolution first.

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
| `olcli upload <file> [project]` | Upload a single file |
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
| `olcli changes doctor [project] --file <path>` | Inspect review capabilities and OT format |
| `olcli changes list [project]` | List native tracked changes without mutating them |
| `olcli changes suggest <file> [project]` | Preview or create one targeted native suggestion |
| `olcli changes accept <file> <id...>` | Accept explicit IDs (`--project`, `--dry-run`) |
| `olcli changes reject <file> <id...>` | Reject explicit IDs (`--project`, `--dry-run`) |
| `olcli review address <thread-id> [project]` | Suggest a linked edit and reply (`--resolve never` by default) |
| `olcli review status [project]` | Inspect the local text-free review ledger |
| `olcli review reconcile [project]` | Classify accepted/rejected/unknown operations safely |
| `olcli review annotate-commit <operation-id>` | Attach a verified Git commit to an operation |
| `olcli review trailers <operation-id>` | Print standard commit trailers |
| `olcli history list [project]` | List native project-history update groups (read-only) |
| `olcli history diff <file> [project]` | Diff a file between native history versions (read-only) |
| `olcli ignored [dir]` | List ignore patterns in effect |
| `olcli config set-url <url>` | Set self-hosted base URL |
| `olcli config set-cookie-name <name>` | Set session cookie name |
| `olcli config set-timeout <ms>` | Set default HTTP timeout |
| `olcli check` | Show config paths and credential sources |

### Global Options

| Flag | Description |
|------|-------------|
| `--verbose` | Print redacted HTTP request metadata to stderr |
| `--unsafe-protocol-logging` | Include raw collaboration frames; disposable projects only |
| `--base-url <url>` | Override Overleaf instance URL |
| `--cookie-name <name>` | Override session cookie name |
| `--timeout <ms>` | Override HTTP timeout (default: 10000) |

## Native tracked changes (experimental)

Use the real-time collaboration path for reviewer-facing edits. A normal
`push` uploads a file and does not create a native tracked suggestion.
Mutation commands require `OLCLI_EXPERIMENTAL_REVIEW=1` or the global
`--experimental-review` flag; read-only inspection and previews remain
available without it.

```bash
# Confirm the document is supported
olcli changes doctor "Paper" --file main.tex

# Inspect existing native insertions and deletions
olcli changes list "Paper" --file main.tex --context 2

# Preview an exact, unique replacement without changing Overleaf
olcli changes suggest main.tex "Paper" \
  --old "A uniquely identifiable sentence." \
  --new "A clearer, uniquely identifiable sentence." \
  --dry-run --json

# Submit and verify the native suggestion
OLCLI_EXPERIMENTAL_REVIEW=1 olcli changes suggest main.tex "Paper" \
  --old "A uniquely identifiable sentence." \
  --new "A clearer, uniquely identifiable sentence." \
  --expected-version 42 \
  --expected-sha256 <sha256-from-preview> \
  --json
```

The commands refuse ambiguous or stale matches, wait for collaboration
acknowledgment, re-read the document and ranges, and restore the prior review
mode after suggestions. Both OT formats have separate adapters; the current
live suite validates `sharejs-text-ot`, while `history-ot` mutation is contract
tested and reported with a doctor warning until a disposable live document is
available. See [native tracked-change compatibility](docs/TRACKED-CHANGES.md).

## Comment-to-change workflow

`olcli review address` verifies that a proposed edit overlaps the selected
comment range, creates a small native tracked suggestion, replies, and records
only identifiers and hashes in `.olcli-review.json`. The safe default leaves
the comment open.

```bash
olcli review address <thread-id> "Paper" \
  --file main.tex \
  --old "Unique original passage" \
  --new "Unique revised passage" \
  --reply "Proposed a tracked revision." \
  --resolve never --dry-run --json

olcli review status "Paper"
olcli review reconcile "Paper" --dry-run --json
```

See [Comment-to-change review workflow](docs/REVIEW-WORKFLOW.md) for ledger
privacy, recovery, resolution policy, and Git trailer details.

For agents, the MCP server defaults to `OLCLI_MCP_REVIEW_MODE=read`. Set it to
`suggest` to allow preconditioned native suggestions and comment replies while
keeping accept/reject, resolution, uploads, renames, and deletes disabled. See
the [MCP review mutation policy](docs/MCP.md#review-mutation-policy).

## Read-only project history

Inspect Overleaf's native update groups without treating them as Git commits or
document OT versions:

```bash
olcli history list "Paper" --limit 20
olcli history diff main.tex "Paper" --from 120 --to 135 --no-content --json
```

History restoration and replay into Git are not supported. See
[read-only Overleaf history](docs/HISTORY.md) for pagination, privacy, binary
files, and MCP defaults.

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

# Upload figures
olcli upload figures/diagram.png

# arXiv submission prep
olcli output bbl -o main.bbl
olcli zip -o arxiv-submission.zip

# Backup all projects
for proj in $(olcli list --json | jq -r '.[].name'); do
  olcli zip "$proj" -o "backups/${proj}.zip"
done
```

## Programmatic Usage (Library API)

`@xyin-anl/olcli` exposes `OverleafClient` and all public interfaces as a library.

### Install

```bash
npm install @xyin-anl/olcli@experimental
```

### Basic example

```ts
import { OverleafClient } from '@xyin-anl/olcli';

const client = await OverleafClient.fromSessionCookie(cookie);

const projects = await client.listProjects();
const info = await client.getProjectInfo(projectId);
const zipBuf = await client.downloadProject(projectId);
const pdfBuf = await client.downloadPdf(projectId);

await client.uploadFile(projectId, null, 'main.tex', readFileSync('main.tex'));

const comments = await client.listComments(projectId, { status: 'open' });
const history = await client.listHistory(projectId, { limit: 20 });
const diff = await client.diffHistory(projectId, 'main.tex', 120, 135, {
  includeContent: false,
});
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
} from '@xyin-anl/olcli';
```

## Further Documentation

- [MCP Server](docs/MCP.md) — AI assistant integration (Claude, Cursor, Windsurf)
- [Git Remote Helper](docs/GIT-REMOTE.md) — use Overleaf as a native git remote
- [Read-only Overleaf history](docs/HISTORY.md) — list updates and diff files safely
- [Protocol compatibility](docs/PROTOCOL-COMPATIBILITY.md) — validated and contract-only paths
- [Migration guide](MIGRATION.md) and [Security guidance](SECURITY.md)

## Troubleshooting

**Session expired** — Get a fresh cookie from the browser and run `olcli auth` again.

**Compilation fails** — Check the Overleaf web editor for detailed error logs (missing packages, syntax errors, missing bibliography files).

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT © [Alexander Loth](https://alexloth.com)
