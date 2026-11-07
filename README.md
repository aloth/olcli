# olcli: Overleaf CLI

**Work on Overleaf projects from your terminal while your coauthors keep using the Overleaf web editor.** Pull, push, sync, diff and compile LaTeX projects; read and answer review comments; use Overleaf as a git remote; give AI agents an MCP server that asks you before it writes.

[![CI](https://github.com/aloth/olcli/actions/workflows/ci.yml/badge.svg)](https://github.com/aloth/olcli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@aloth/olcli.svg)](https://www.npmjs.com/package/@aloth/olcli)
[![npm downloads](https://img.shields.io/npm/dm/@aloth/olcli.svg)](https://www.npmjs.com/package/@aloth/olcli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23896243.svg)](https://doi.org/10.5281/zenodo.23896243)
[![Glama MCP server](https://glama.ai/mcp/servers/aloth/olcli/badges/score.svg)](https://glama.ai/mcp/servers/aloth/olcli)
[![AgentSkills](https://img.shields.io/badge/AgentSkills-compatible-blue)](https://agentskills.io)

- **Coauthors change nothing.** They keep editing, commenting and compiling in the browser; you work in Vim, VS Code, Emacs or an agent and sync with the same project.
- **Works on the free Overleaf plan.** Pull, push, sync, diff, latexdiff, compile, PDF and output downloads, file operations, zip, comment listing and the git remote helper were checked on a free overleaf.com account. Tracked changes are the exception: Overleaf itself only offers them in premium projects.
- **Works on self-hosted Overleaf Community Edition** with the same commands.
- **No git token, no paid plan.** olcli signs in with your normal Overleaf session. Overleaf's own Git integration is a premium feature; olcli's git remote helper is not tied to it.
- **One package:** command-line tool, git remote helper, MCP server and TypeScript library.

> **If olcli saves you time, please star the repository.** To reference it in a paper, see [Citation](#citation).

<p align="center">
  <img src="screenshots/demo.gif" alt="olcli demo" width="600">
</p>

<p align="center">
  <img src="screenshots/latexdiff.gif" alt="olcli diff --latexdiff --pdf turns a local edit into a marked-up PDF" width="600">
</p>

## Install

```bash
brew install aloth/tap/olcli      # Homebrew (macOS, Linux)
npm install -g @aloth/olcli       # npm (any platform, Node 20.18.1 or newer)
```

On Linux with Nix: `nix run github:aloth/olcli -- --help`. Without installing: `npx @aloth/olcli list`. For AI agents through AgentSkills: `npx skills add aloth/olcli`.

## Quick start

```bash
olcli auth --browser          # sign in through a browser window
olcli list                    # your projects
olcli pull "My Thesis"        # download into ./My_Thesis
cd My_Thesis
vim main.tex
olcli diff                    # what would change on Overleaf
olcli push                    # upload your edits
olcli pdf                     # compile on Overleaf and download the PDF
```

`olcli auth --browser` opens the login page in Chrome, Edge, Chromium or Brave with a new temporary profile (never your own), waits until you have signed in, and keeps only the session cookie. It works with SSO, Google, ORCID and two-factor logins, and olcli never sees your password. It needs Node 22 or newer; set `OLCLI_BROWSER` when your browser is not found.

### Sign in with a session cookie

No supported browser, or a server without a display? Paste the cookie instead:

```bash
olcli auth --cookie           # prompts, input stays hidden
pbpaste | olcli auth --cookie -   # or read it from stdin
olcli auth status             # instance, account, where the credential comes from
```

**Get your session cookie:** sign in to Overleaf in a browser, open the developer tools (F12), then Application (Chrome, Edge) or Storage (Firefox), Cookies, and copy the value of `overleaf_session2` (`overleaf.sid` on most self-hosted instances). A value on the command line also works but lands in your shell history.

Self-hosted instances without reCAPTCHA also accept `olcli auth --email you@example.com`, which prompts for the password. Scripts can set `OVERLEAF_SESSION`, or `OVERLEAF_EMAIL` and `OVERLEAF_PASSWORD`, and skip `olcli auth` entirely.

### Self-hosted Overleaf

```bash
olcli config set-url https://latex.example.org
olcli config set-cookie-name overleaf.sid
olcli auth --browser
```

Or per command: `olcli --base-url https://latex.example.org list`. The MCP server and the git remote helper read `OVERLEAF_BASE_URL` and `OVERLEAF_COOKIE_NAME`.

## Features

- **Pull, push, sync** with nested folders, local deletions propagated on `sync`, and LaTeX build artifacts ignored ([ignore rules](docs/CONFIGURATION.md#ignoring-files))
- **Diff** local files against the live project before you push, with `--exit-code` for CI ([docs/DIFF.md](docs/DIFF.md))
- **Marked-up revisions:** `olcli diff --latexdiff --pdf` builds the struck-through and underlined PDF advisors and journals ask for, compiled on Overleaf, no local TeX needed (needs `latexdiff` on PATH)
- **Compile and download** the PDF, a single root document (`-r appendix.tex`), or compile outputs such as `.bbl` for arXiv
- **Files:** upload, download, delete, rename and move by path; download the project as a zip
- **Review comments:** list, add, reply, resolve, reopen and delete comment threads
- **Tracked changes:** list suggested insertions and deletions, accept or reject them. Track changes is an Overleaf premium feature: it is only available in projects whose owner has a premium plan, and invited collaborators on any plan can then use it. In other projects there are no tracked changes to list
- **Projects:** create, rename, and bulk-rename by pattern (dry run unless `--apply`)
- **Git remote:** `git clone overleaf::https://www.overleaf.com/project/<id>` ([docs/GIT-REMOTE.md](docs/GIT-REMOTE.md))
- **MCP server** for AI agents; every tool that writes asks you first ([docs/MCP.md](docs/MCP.md))
- **Forgiving project names:** case-insensitive, unique prefixes, "Did you mean" suggestions
- **Scriptable:** `--json` on listings, plain output when piped, `NO_COLOR`, exit codes that mean something

## Use with Claude Code, Codex and Cursor

olcli ships an MCP server, `olcli-mcp`. Add it to `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) or your client's MCP settings:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "--package", "@aloth/olcli", "olcli-mcp"]
    }
  }
}
```

Codex uses TOML in `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.overleaf]
command = "npx"
args = ["-y", "--package", "@aloth/olcli", "olcli-mcp"]
```

The server uses the session stored by `olcli auth`; set `OVERLEAF_SESSION` in `env` instead if you prefer. Every tool that changes a project (push a file, delete, rename, comment, accept or reject tracked changes, create a project) shows you what it will do and writes only after you confirm it in the client. The server tells the agent that project content, such as comments and document text, is data and not instructions. Details, the full tool list and clients without confirmation support: [docs/MCP.md](docs/MCP.md).

## Commands

Inside a pulled directory (it contains `.olcli.json`), the project argument can be left out. `olcli <command> --help` shows every option with examples.

| Command | Description |
|---------|-------------|
| `olcli auth` | Sign in: `--browser`, `--cookie`, or `--email` |
| `olcli auth status` | Instance, account, credential source; exits 1 when not signed in |
| `olcli logout` | Clear stored credentials |
| `olcli list` | List projects (`--json`, `-n`) |
| `olcli info [project]` | Project details and file list |
| `olcli project create <name>` | Create a blank or example project (`--template`) |
| `olcli project rename <new> [project]` | Rename the project itself |
| `olcli project rename-bulk` | Rename many projects by pattern (dry run unless `--apply`) |
| `olcli pull [project] [dir]` | Download project files |
| `olcli push [dir]` | Upload local changes (`--dry-run`, `--all`, `--delete`) |
| `olcli sync [dir]` | Pull then push, propagating local deletions (`--no-delete`, `--dry-run`) |
| `olcli diff [project] [dir]` | Content diff against the live project (`--name-only`, `--exit-code`, `--latexdiff`, `--pdf`) |
| `olcli upload <file> [project]` | Upload one file (`--to <path>`) |
| `olcli download <file> [project]` | Download one file (`-o`) |
| `olcli delete <file> [project]` | Delete a file or folder (alias `rm`) |
| `olcli rename <old> <new> [project]` | Rename or move a file or folder (alias `mv`) |
| `olcli zip [project]` | Download the project as a zip archive |
| `olcli compile [project]` | Compile on Overleaf (`-r <root.tex>`) |
| `olcli pdf [project]` | Compile and download the PDF (`-o`, `-r`) |
| `olcli output [type]` | Download compile outputs such as `bbl` or `log` (`--list`) |
| `olcli comments list [project]` | List comments (`--status`, `--context`, `--changes`, `--json`) |
| `olcli comments add <file> <message>` | Comment on selected text |
| `olcli comments reply <id> <body>` | Reply to a thread |
| `olcli comments resolve <id>` | Resolve a thread (`reopen` and `delete` too) |
| `olcli changes accept <ids...>` | Accept tracked changes (premium projects) |
| `olcli changes reject <ids...>` | Reject tracked changes; preview unless `--yes` |
| `olcli config set-url <url>` | Set the instance URL (`get-url`, `set-cookie-name`, `set-timeout`) |
| `olcli ignored [dir]` | Show the ignore patterns in effect |

Global options: `--base-url <url>`, `--cookie-name <name>`, `--timeout <ms>`, `--verbose` (print every HTTP request), `--no-color`.

## How sync works

- `pull` downloads every file and skips local files changed since the last pull; `--force` overwrites them.
- `push` uploads files changed since the last pull and keeps the folder structure. `push --dry-run` lists them; `olcli diff` shows what actually differs.
- `sync` pulls, then pushes. Local edits win when they are newer, and a file you deleted locally is deleted on Overleaf (`--no-delete` to opt out; `sync --dry-run --verbose` to preview).
- Before a push, `olcli diff` compares against the project as it is on Overleaf right now, so you see a coauthor's newer edit before you overwrite it.

## Examples

```bash
# Daily thesis workflow
olcli pull "PhD Thesis" thesis && cd thesis
olcli sync && olcli pdf -o draft.pdf

# Marked-up PDF of your local revision for your advisor
olcli diff --latexdiff --pdf

# Fail a CI job when the paper on Overleaf drifted from the repository
olcli diff --exit-code --name-only

# Review comments, with two lines of context
olcli comments list --status open --context 2

# arXiv submission prep
olcli output bbl -o main.bbl
olcli zip -o arxiv-submission.zip

# Back up every project
for proj in $(olcli list --json | jq -r '.[].name'); do
  olcli zip "$proj" -o "backups/${proj}.zip"
done
```

## Proxy

olcli honors `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY` (lower-case names take precedence) for every request. https:// instances are reached through a CONNECT tunnel, so the proxy never sees the session cookie. `localhost` and loopback addresses are always reached directly. `--verbose` names the proxy used for each request.

```bash
HTTPS_PROXY=http://proxy.example.org:3128 olcli list
```

## Configuration and credentials

Credentials are read in this order: `OVERLEAF_SESSION`, then `.olauth` in the current directory (written by `olcli auth --save-local`), then the global config. `olcli auth status` shows which one is used and where it lives. The session cookie is stored in plaintext; a password only when you pass `--save-password`. `olcli logout` clears the global config and `.olauth`.

Every environment variable, the timeout setting and the ignore rules (`.olignore`, `.olignore.local`) are described in [docs/CONFIGURATION.md](docs/CONFIGURATION.md). `olcli --help` lists the variables too.

## Library

```ts
import { OverleafClient } from '@aloth/olcli';

const client = await OverleafClient.fromSessionCookie(cookie);
const projects = await client.listProjects();
const pdf = await client.downloadPdf(projects[0].id);
```

All exports: [docs/LIBRARY.md](docs/LIBRARY.md).

## Troubleshooting

- **"Session expired or invalid. Run: olcli auth"**: sessions expire; sign in again. `olcli auth status` tells you which credential was used.
- **Timeouts on large projects:** `olcli config set-timeout 60000`, or `--timeout 60000` once.
- **Compilation fails:** the Overleaf web editor shows the full log; `olcli output log` downloads it.
- **Anything else:** run the command with `--verbose` and include the output (without the cookie) in an issue.

## Documentation

- [docs/DIFF.md](docs/DIFF.md): diff, latexdiff and the CI gate
- [docs/MCP.md](docs/MCP.md): MCP server, tools and write confirmation
- [docs/GIT-REMOTE.md](docs/GIT-REMOTE.md): Overleaf as a git remote
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): credentials, environment variables, timeout, ignore rules
- [docs/LIBRARY.md](docs/LIBRARY.md): TypeScript library
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the client talks to Overleaf (there is no public Overleaf API, so it uses a browser session)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, which tests need a real Overleaf account, and what CI checks on a pull request.

## Citation

If you use olcli in your research, please cite it. GitHub's "Cite this repository" button in the sidebar gives the reference in APA and BibTeX, from [CITATION.cff](CITATION.cff). The DOI [10.5281/zenodo.23896243](https://doi.org/10.5281/zenodo.23896243) always resolves to the latest version.

```bibtex
@software{loth_olcli,
    author = {Loth, Alexander},
    title  = {{olcli}: Command-line interface for Overleaf},
    doi    = {10.5281/zenodo.23896243},
    url    = {https://github.com/aloth/olcli}
}
```

## License

MIT © [Alexander Loth](https://alexloth.com)
