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
2. **`~/.olauth` file** — written by `olcli auth`
3. **Stored config** — written by `olcli auth`

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

- Clone and fetch intentionally import the current Overleaf snapshot as one
  "Import from Overleaf" commit. The separate read-only history commands can
  inspect native update groups and file diffs, but they do not replay them as
  Git commits.
- Concurrent edits on Overleaf between your fetch and push may cause conflicts — push uploads your version of changed files.
- Binary files are supported but large files may be slow (uploaded individually via the Overleaf API).
