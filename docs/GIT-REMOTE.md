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
- **Known bug: `git fetch` and `git pull` do not pick up changes made on Overleaf after the clone.** The helper reports the commit you already have as the state of the remote, so git never downloads the project again. A `git push` then uploads your version of every file your commits changed and overwrites a coauthor's newer edits in those files without a warning. Running `git pull` before `git push` does not protect you. Until this is fixed, check the project before every push from the top level of the clone:

  ```bash
  olcli diff "<project name or id>" --name-only
  ```

  `olcli diff` downloads the project as it is on Overleaf right now. If it lists files you did not change, a coauthor edited them: pull those edits into your clone (for example with `olcli pull "<project>" --force` in a separate directory and copying the files over) before you push. For projects you edit together with others, `olcli pull` and `olcli push` with `olcli diff` are the safer workflow for now.
- Binary files are supported but large files may be slow (uploaded individually via the Overleaf API).
