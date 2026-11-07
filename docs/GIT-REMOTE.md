# Git Remote Helper

Use Overleaf projects as native git remotes. Clone, pull, and push with standard git commands — no wrapper scripts needed.

## Quick Start

```bash
# Clone an Overleaf project
git clone overleaf::https://www.overleaf.com/project/<id>

# Work normally
cd <project>
vim main.tex
git add . && git commit -m "update introduction"

# Push changes to Overleaf
git push
```

## How It Works

`git-remote-overleaf` implements git's `fast-import`/`fast-export` protocol with mark-based tracking:

- **Clone/fetch:** Downloads the project zip, emits a fast-import stream with one commit containing the full tree.
- **Push:** Parses the fast-export stream to determine file modifications and deletions, then calls the Overleaf API to upload/delete only what changed.
- **Pull:** Downloads the project and compares a sha256 of every file with the state recorded at the last fetch or push (`.git/overleaf/state.json`); only a change produces a new commit.

State is stored in `.git/overleaf/` (marks file + manifest).

## Authentication

The helper reads credentials in this order:

1. **`OVERLEAF_SESSION` environment variable** (recommended for scripting)
2. **`.olauth` file in the current directory** — written by `olcli auth --save-local`
3. **Stored config** — written by `olcli auth`

Git runs the helper from the top level of the repository, and for `git clone` from the directory you run the clone in, so that is where `.olauth` is looked up. A `~/.olauth` is only read when git runs in your home directory.

```bash
# Option A: environment variable
export OVERLEAF_SESSION="s%3A..."
git clone overleaf::https://www.overleaf.com/project/abc123

# Option B: authenticate once with olcli
olcli auth --cookie "s%3A..."
git clone overleaf::https://www.overleaf.com/project/abc123
```

## Custom Instances

For self-hosted Overleaf, just use your instance URL:

```bash
git clone overleaf::https://overleaf.yourcompany.com/project/<id>
```

Set `OVERLEAF_BASE_URL` for the helper to resolve project IDs without the full URL:

```bash
export OVERLEAF_BASE_URL=https://overleaf.yourcompany.com
```

## Debugging

Enable verbose logging:

```bash
GIT_REMOTE_OVERLEAF_DEBUG=1 git push origin main
```

## Limitations

- Overleaf has no native revision history exposed via API, so each clone creates a single "Import from Overleaf" commit (no history replay).
- **Coauthors' edits are not overwritten by accident.** `git fetch` and `git pull` download the project and compare every file with the state of the last fetch or push, so they bring in edits made on Overleaf and write no commit when nothing changed. `git push` is refused, like a non-fast-forward push, when Overleaf has changes you have not fetched yet, or when your branch does not contain the last fetch (for example after a `git pull` whose merge conflict is still open). Run `git pull`, resolve any conflict, commit, then push again. `git push --force` overwrites Overleaf on purpose. Clones made with olcli 0.16.0 or earlier have no record of the Overleaf state yet: run `git pull` once before the first push.
- A fetch or push downloads the whole project once to compare it, so on a large project it takes as long as an `olcli pull`. Overleaf limits how often a project can be downloaded; many fetches in a few minutes can be answered with HTTP 429 (wait a minute and retry).
- Binary files are supported but large files may be slow (uploaded individually via the Overleaf API).
