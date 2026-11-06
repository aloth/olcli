# Configuration

## Credentials

Credentials are checked in this order:

1. `OVERLEAF_SESSION` environment variable
2. `.olauth` file in the current directory
3. Global config; run `olcli auth status` to see the exact path

The global config path is platform-dependent (`conf` resolves it), so it is not hardcoded here: on macOS it lands under `~/Library/Preferences/`, on Linux under `~/.config/`. `olcli auth` prints the path it wrote to.

`olcli auth --save-local` writes `.olauth` into the **current directory**, which is usually your LaTeX project. Add it to that project's `.gitignore` before committing.

### What is stored, and how to clear it

Everything is stored in plaintext, so it is worth knowing what is on disk:

| Credential | Stored by default | Where |
|---|---|---|
| Session cookie | yes | global config, or `.olauth` with `--save-local` |
| Email + password | **no**, only with `--save-password` | global config |

`olcli auth status` reports what exists without printing any secret; the cookie is masked to its last four characters.

`olcli logout` clears the global config **and** the `.olauth` file in the current directory, then lists what it removed. It cannot unset environment variables, so if `OVERLEAF_SESSION` or `OVERLEAF_EMAIL`/`OVERLEAF_PASSWORD` are set, it says so instead of implying you are logged out; those take precedence over anything on disk.

### Password login

Self-hosted instances without reCAPTCHA accept a password login:

```bash
olcli auth --email "you@example.com"
# prompts for the password, so it stays out of your shell history
```

The password is **not stored** unless you pass `--save-password`. A session cookie is saved either way and is what later commands use; the password only buys an automatic re-login once that cookie expires. For scripts, set `OVERLEAF_EMAIL` and `OVERLEAF_PASSWORD`: every command reads them, so a scripted run never needs `olcli auth` at all.

## Self-hosted Overleaf

```bash
olcli config set-url https://latex.example.org
olcli config set-cookie-name overleaf.sid
```

Or pass it per command: `olcli --base-url https://latex.example.org list`. `olcli config get-url` and `olcli config get-cookie-name` show the stored values.

## Timeout

```bash
olcli config set-timeout 60000          # persist
olcli --timeout 60000 pull "Big Thesis" # one-off
export OVERLEAF_TIMEOUT=60000           # env var
```

Precedence: `--timeout` > `OVERLEAF_TIMEOUT` > config > default (10000 ms).

## Environment variables

olcli reads these. The MCP server and the git remote helper read the same session, password and cookie name variables. Where a flag exists, the flag takes precedence over the variable, and the variable over the stored config.

| Variable | Purpose |
|---|---|
| `OVERLEAF_SESSION` | Session cookie value |
| `OVERLEAF_EMAIL`, `OVERLEAF_PASSWORD` | Password login, used when no session cookie is set or it is rejected |
| `OVERLEAF_BASE_URL` | Instance URL, like `--base-url` (default: `https://www.overleaf.com`) |
| `OVERLEAF_COOKIE_NAME` | Session cookie name, like `--cookie-name` (default: `overleaf_session2`; self-hosted instances often use `overleaf.sid`) |
| `OVERLEAF_TIMEOUT` | HTTP timeout in milliseconds, like `--timeout` |
| `OLCLI_CONCURRENCY` | Documents fetched in parallel by `comments list`, 1 to 8 (default: 4); `--concurrency` takes precedence |
| `OLCLI_BROWSER` | Browser for `olcli auth --browser` (an executable, or a macOS `.app` bundle) when it is not found in the usual places |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | Proxy for https:// and http:// instances, and hosts that bypass it; lower-case names take precedence. Loopback is always direct |
| `NO_COLOR` | Turn off color, like `--no-color` |
| `OLCLI_MCP_UNCONFIRMED_WRITES` | MCP server only: `1` turns off write confirmation, see [MCP.md](MCP.md#write-confirmation) |
| `GIT_REMOTE_OVERLEAF_DEBUG` | Git remote helper only: `1` prints protocol debug output, see [GIT-REMOTE.md](GIT-REMOTE.md#debugging) |

## Ignoring files

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

## How deletion propagation works

`olcli` records a manifest of remote files in `.olcli.json`. On the next sync:

- File missing locally and still on the remote: deleted on Overleaf
- File new locally: uploaded
- File modified locally: uploaded (local wins)
- File only on the remote: downloaded

First-time syncs skip the deletion phase (no prior manifest to compare). `push` propagates deletions only with `--delete`; `sync --no-delete` turns it off for `sync`.
