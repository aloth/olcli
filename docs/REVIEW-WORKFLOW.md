# Comment-to-change review workflow

The `review` commands connect one Overleaf comment to one targeted native
tracked suggestion. They use the same real-time, preconditioned mutation path
as `changes suggest`; they do not upload a replacement file.

## Address a comment

Always preview first:

```bash
olcli review address <thread-id> "Paper" \
  --file main.tex \
  --old "Unique original passage" \
  --new "Unique revised passage" \
  --reply "Proposed a tracked revision." \
  --resolve never \
  --dry-run --json
```

Carry the returned `suggestion.version` and `suggestion.textSha256` into the
mutation. Supplying an operation UUID makes an interrupted comment action
resumable without creating a second suggestion:

```bash
olcli review address <thread-id> "Paper" \
  --file main.tex \
  --old "Unique original passage" \
  --new "Unique revised passage" \
  --reply "Proposed a tracked revision." \
  --resolve never \
  --operation-id <uuid> \
  --expected-version <version> \
  --expected-sha256 <sha256> --json
```

By default, the edit must overlap the comment's selected source range. Use
`--allow-unrelated` only after manually checking an intentionally nearby or
cross-document edit.

## Resolution policies

| Policy | Behavior |
|---|---|
| `never` | Reply and leave the comment open. This is the default. |
| `after-suggest` | Resolve immediately after the verified suggestion and reply. |
| `after-accept` | Leave open, then resolve only when reconciliation proves acceptance. |

`after-accept` does not infer acceptance merely because change IDs disappear.
The current visible source hash must match the stored expected revised hash.
The original hash classifies rejection; every other result remains `unknown`
and leaves the comment open.

```bash
olcli review status "Paper"
olcli review reconcile "Paper" --dry-run --json
olcli review reconcile "Paper" --json
```

Reconciliation is idempotent. It also serializes collaboration reads because
some legacy Overleaf servers do not reliably acknowledge simultaneous
`joinDoc` calls for one project.

## Local ledger

The default ledger is `.olcli-review.json`. It is excluded by this repository's
Git rules and olcli's built-in sync rules, written atomically with mode `0600`,
and bound to one project ID. A corrupt ledger is copied to a timestamped backup
and is never silently overwritten. A process lock makes concurrent writers
fail visibly instead of silently losing another agent's entry.

The ledger stores only:

- operation, project, thread, document, and change identifiers;
- source version and source/result/request SHA-256 hashes;
- state, timestamps, resolution policy, and reply status;
- the current Git commit when one is available.

It never stores source passages, reply bodies, reviewer identity, session
cookies, or CSRF tokens.

If a mutation fails after a `prepared` entry is written, olcli refuses to
automatically repeat it because the server may have applied an unacknowledged
operation. Inspect Overleaf and reconcile before starting a new operation.
If a process crashes while holding `.olcli-review.json.lock`, confirm no olcli
process is still writing the ledger before removing that stale lock manually.

## Git metadata

The workflow detects the current Git commit without requiring Git. A later
commit can be attached to an operation without rewriting Git history:

```bash
olcli review annotate-commit <operation-id> "Paper" --commit HEAD
olcli review trailers <operation-id> "Paper"
```

The trailer command prints `Overleaf-Project`, `Overleaf-Document`,
`Overleaf-Thread`, `Overleaf-Changes`, `Overleaf-Source-Version`, and
`Olcli-Review-Operation` trailers for use in a commit message.

## Agent boundary

The workflow is available through the CLI, programmatic library, and MCP. MCP
starts in read-only mode; agent-facing mutation requires the experimental
feature gate, a review mode of `suggest` or `full`, a dry-run preview, and fresh
document version/hash preconditions. See [MCP.md](MCP.md).
