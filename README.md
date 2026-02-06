# olcli — Overleaf CLI

**Command-line interface for Overleaf** — Sync, manage, and compile LaTeX projects from your terminal.

[![npm version](https://img.shields.io/npm/v/@aloth/olcli.svg)](https://www.npmjs.com/package/@aloth/olcli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Work with Overleaf projects directly from your command line. Edit locally with your favorite editor, version control with Git, and sync seamlessly with Overleaf's cloud compilation.

<p align="center">
  <img src="screenshots/demo.gif" alt="olcli demo" width="600">
</p>

## Features

**Full Overleaf command-line access:**

- 📋 **List** all your Overleaf projects
- ⬇️ **Pull** project files to local directory for offline editing
- ⬆️ **Push** local changes back to Overleaf
- 🔄 **Sync** bidirectionally with smart conflict detection
- 📄 **Compile** PDFs using Overleaf's remote compiler
- 📦 **Download** individual files or full project archives
- 📤 **Upload** files to projects
- 📊 **Output** compile artifacts (`.bbl`, `.log`, `.aux` for arXiv submissions)

**Perfect for:**
- Editing LaTeX in your preferred text editor (Vim, VS Code, Emacs, etc.)
- Version control with Git while using Overleaf's compiler
- Automating workflows and CI/CD pipelines
- Offline work with periodic sync
- Collaborative projects where some prefer CLI, others prefer web

## Installation

### Homebrew (macOS/Linux)

```bash
brew tap aloth/tap
brew install olcli
```

### npm (all platforms)

Install globally to use the `olcli` command anywhere:

```bash
npm install -g @aloth/olcli
```

Or use with `npx` without installation:

```bash
npx @aloth/olcli list
```

## Quick Start

### 1. Authenticate with Overleaf

Get your session cookie from Overleaf.com:

1. Log into [overleaf.com](https://www.overleaf.com)
2. Open Developer Tools (F12 or Cmd+Option+I) → Application/Storage → Cookies
3. Copy the value of `overleaf_session2`

Store it with olcli:

```bash
olcli auth --cookie "your_session_cookie_value"
```

**Tip:** The cookie stays valid for weeks. Just refresh it when authentication fails.

### 2. List Your Projects

```bash
olcli list
```

See all your Overleaf projects with IDs and last modified dates.

### 3. Pull a Project Locally

Download any project to work on it locally:

```bash
olcli pull "My Thesis"
cd My_Thesis/
```

Now you can edit `.tex` files with your preferred editor (Vim, VS Code, Emacs, etc.).

### 4. Edit Locally, Sync to Overleaf

```bash
# Edit files locally with your favorite editor
vim main.tex

# Push changes back to Overleaf
olcli push

# Or sync bidirectionally (pull + push in one command)
olcli sync
```

Your collaborators can continue using the Overleaf web editor — changes sync seamlessly.

### 5. Compile and Download PDF

Use Overleaf's remote compiler from the command line:

```bash
olcli pdf
```

The compiled PDF downloads automatically to your current directory.

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

## Use Cases

### Local Editing with Overleaf Compilation

Work offline in your favorite editor, push when ready, compile remotely:

```bash
olcli pull "Research Paper"
cd Research_Paper
vim introduction.tex
git commit -am "Update intro"
olcli push
olcli pdf
```

### Git Version Control + Overleaf

Keep your LaTeX project in Git while using Overleaf's compiler:

```bash
olcli pull "My Thesis" thesis
cd thesis
git init
git add .
git commit -m "Initial import from Overleaf"

# Daily workflow
vim chapters/methods.tex
git commit -am "Draft methods section"
olcli sync  # Sync with Overleaf
olcli pdf
```

### Automated Workflows

Integrate Overleaf compilation into CI/CD:

```bash
#!/bin/bash
olcli auth --cookie "$OVERLEAF_SESSION"
olcli pull "Automated Report"
./generate-data.py > tables/results.tex
olcli push
olcli pdf -o report-$(date +%Y-%m-%d).pdf
```

### arXiv Submissions

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
