# olcli

**Overleaf CLI** — Sync and manage your LaTeX projects from the command line.

[![npm version](https://img.shields.io/npm/v/@aloth/olcli.svg)](https://www.npmjs.com/package/@aloth/olcli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<p align="center">
  <img src="screenshots/demo.gif" alt="olcli demo" width="600">
</p>

## Features

- 📋 **List** all your Overleaf projects
- ⬇️ **Pull** project files to local directory
- ⬆️ **Push** local changes back to Overleaf
- 🔄 **Sync** bidirectionally with smart conflict detection
- 📄 **Compile** and download PDFs
- 📦 **Download** individual files or full project archives
- 📤 **Upload** files to projects
- 📊 **Output** compile artifacts (`.bbl`, `.log`, `.aux` for arXiv submissions)

## Installation

### Homebrew (macOS/Linux)

```bash
brew tap aloth/tap
brew install olcli
```

### npm

```bash
npm install -g @aloth/olcli
```

## Quick Start

### 1. Authenticate

Get your session cookie from Overleaf:

1. Log into [overleaf.com](https://www.overleaf.com)
2. Open Developer Tools (F12) → Application → Cookies
3. Copy the value of `overleaf_session2`

```bash
olcli auth --cookie "your_session_cookie_value"
```

### 2. List Projects

```bash
olcli list
```

### 3. Pull a Project

```bash
olcli pull "My Thesis"
cd My_Thesis/
```

### 4. Edit and Sync

```bash
# Edit files locally with your favorite editor
vim main.tex

# Push changes back to Overleaf
olcli push

# Or sync bidirectionally
olcli sync
```

### 5. Compile and Download PDF

```bash
olcli pdf
```

## Commands

All commands auto-detect the project when run from a synced directory (contains `.olcli.json`).

| Command | Description |
|---------|-------------|
| `olcli auth` | Set session cookie |
| `olcli whoami` | Check authentication status |
| `olcli logout` | Clear stored credentials |
| `olcli list` | List all projects |
| `olcli info [project]` | Show project details and file list |
| `olcli pull [project] [dir]` | Download project files to local directory |
| `olcli push [dir]` | Upload local changes to Overleaf |
| `olcli sync [dir]` | Bidirectional sync (pull + push) |
| `olcli upload <file> [project]` | Upload a single file |
| `olcli download <file> [project]` | Download a single file |
| `olcli zip [project]` | Download project as zip archive |
| `olcli compile [project]` | Trigger PDF compilation |
| `olcli pdf [project]` | Compile and download PDF |
| `olcli output [type]` | Download compile output files |
| `olcli check` | Show config paths and credential sources |

## arXiv Submissions

Download the `.bbl` file for arXiv submissions:

```bash
olcli output bbl --project "My Paper"
# Downloads: bbl
```

List all available compile output files:

```bash
olcli output --list
# Available output files:
#   aux          output.aux
#   bbl          output.bbl
#   blg          output.blg
#   log          output.log
#   ...
```

## Sync Behavior

### Pull
- Downloads all files from Overleaf
- **Skips** local files modified after last pull (won't overwrite your changes)
- Use `--force` to overwrite local changes

### Push
- Uploads files modified after last pull
- Use `--all` to upload all files
- Use `--dry-run` to preview changes

### Sync
- Pulls remote changes
- Preserves local modifications (local wins if newer)
- Pushes local changes to remote
- Use `--verbose` to see detailed file operations

## Configuration

Credentials are stored in (checked in order):

1. `OVERLEAF_SESSION` environment variable
2. `.olauth` file in current directory
3. Global config: `~/.config/olcli-nodejs/config.json` (macOS/Linux)

### .olauth File

For project-specific credentials, create `.olauth` in your project directory:

```
s%3AyourSessionCookieValue...
```

## Examples

### Work on a thesis

```bash
# Initial setup
olcli pull "PhD Thesis" thesis
cd thesis

# Daily workflow
vim chapters/introduction.tex
olcli sync
olcli pdf -o draft.pdf
```

### Quick PDF download

```bash
olcli pdf "Conference Paper" -o paper.pdf
```

### Download a single file

```bash
olcli download main.tex "My Project"
```

### Upload figures

```bash
cd my-project
olcli upload figures/diagram.png
```

### Backup all projects

```bash
for proj in $(olcli list --json | jq -r '.[].name'); do
  olcli zip "$proj" -o "backups/${proj}.zip"
done
```

### Prepare for arXiv

```bash
cd my-paper
olcli output bbl -o main.bbl
olcli zip -o arxiv-submission.zip
```

## Troubleshooting

### Session expired

If you get authentication errors, your session cookie may have expired. Get a fresh one from the browser and run `olcli auth` again.

### Compilation fails

Check the Overleaf web editor for detailed error logs. Common issues:
- Missing packages
- Syntax errors in `.tex` files
- Missing bibliography files

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT © [Alexander Loth](https://alexloth.com)
