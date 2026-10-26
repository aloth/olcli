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
- **Pull:** Compares marks to detect if the remote has new content; skips download when up-to-date.

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
- **A push can overwrite a coauthor's edits.** A push uploads your version of every file your commits changed. If a coauthor edited one of those files in Overleaf after your last fetch, their edit is overwritten without a warning or a conflict; the helper does not check what changed on Overleaf in between. The workaround is to fetch right before you push: run `git pull`, which fetches from Overleaf and merges, resolve any conflicts locally, then `git push` right away, so the push contains their edits.
- Binary files are supported but large files may be slow (uploaded individually via the Overleaf API).
