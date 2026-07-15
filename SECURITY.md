# Security

This fork talks to undocumented Overleaf endpoints using an authenticated
browser session. Treat it as experimental software with account-level access,
not as a security boundary around Overleaf.

## Credentials

- An Overleaf session cookie can grant broad account access. Never commit,
  paste into a prompt, print in logs, or pass it as a command-line argument.
- Prefer the `OVERLEAF_SESSION` environment variable in a protected process
  manager, or `olcli auth` with the generated `.olauth` file kept at mode
  `0600`. `.olauth` is gitignored.
- Use a dedicated Overleaf account and disposable project for protocol tests.
- Rotate the session immediately if it appears in terminal output, a commit,
  an issue, or an agent transcript.

## Agent least privilege

The MCP server defaults to `OLCLI_MCP_REVIEW_MODE=read`. Use `suggest` for the
normal reviewer workflow. `full` also permits accept/reject, comment
resolution, file upload, new comments, rename, and deletion.

Experimental tracked-review mutations require a second opt-in:

```text
OLCLI_EXPERIMENTAL_REVIEW=1
```

Mutation-shaped MCP tools still default to `dry_run: true` and require a fresh
document version and SHA-256 precondition. Keep comment resolution policy at
`never` unless the agent has explicit authority to resolve discussions.

## Content and metadata

- `--unsafe-protocol-logging` can expose manuscript text, comments, tracked
  changes, cookies, and collaboration frames. Use it only on synthetic data.
- History author normalization omits email fields. MCP history diffs omit
  source content unless `include_content` is explicitly enabled.
- `.olcli-review.json` stores identifiers and hashes rather than passages,
  reply bodies, credentials, or reviewer identity. It can still reveal project
  structure and workflow state; protect it accordingly.
- `pull_project`, `download_file`, and `download_pdf` write local files. Limit
  the MCP process working directory and filesystem permissions.

## Protocol and concurrency risk

Overleaf can change internal REST, Socket.IO, ShareJS, or history-OT behavior
without notice. The client fails visibly on unknown response shapes, but no
compatibility guarantee exists. Back up the project in Git, make small targeted
edits, verify returned change IDs, compile, and inspect in Overleaf after every
mutation.

Do not run first experiments on production manuscripts. Concurrent browser and
agent sessions can race; version and source-hash preconditions prevent known
stale writes but cannot make undocumented services transactional.

## Reporting

Report a suspected vulnerability privately to the fork owner rather than in a
public issue. Include the affected version and a synthetic reproduction, but
do not include cookies, CSRF tokens, project/document/thread IDs, emails, or
real manuscript text.
