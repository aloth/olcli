# Read-only Overleaf history

`olcli` can list native Overleaf project-history update groups and diff one
file between two project-history versions. This feature is deliberately
read-only: it does not restore versions, create labels, or replay Overleaf
history as Git commits.

The integration uses Overleaf's undocumented editor endpoints. The current
request and response shapes are derived from Overleaf's open-source frontend
and server:

- [`GET /project/:id/updates`](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/history/services/api.ts)
- [`GET /project/:id/filetree/diff`](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/history/services/api.ts)
- [`GET /project/:id/diff`](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/history/services/api.ts)
- [history route definitions](https://github.com/overleaf/overleaf/blob/main/services/web/app/src/Features/History/HistoryRouter.mjs)

These endpoints can change without notice. Malformed or unfamiliar responses
fail visibly instead of being guessed at.

## CLI

```bash
# List the newest 20 update groups
olcli history list "Paper" --limit 20

# Continue from the cursor printed by the previous command
olcli history list "Paper" --before 135 --limit 20

# Inspect a textual diff
olcli history diff main.tex "Paper" --from 120 --to 135

# Return only counts and metadata; do not return source text
olcli history diff main.tex "Paper" --from 120 --to 135 --no-content --json
```

`--min-count` controls the minimum batch requested from Overleaf. It is not a
server-side maximum, so the service applies `--limit` after normalizing and
deduplicating entries. Use the returned `nextBefore` value as the next
`--before` cursor.

Text diffs omit unchanged chunks by default. Add `--include-unchanged` only
when the caller genuinely needs them because that can return most of a
document. Binary files return file metadata with `binary: true` and no text
chunks.

## Library

```ts
const page = await client.listHistory(projectId, {
  limit: 20,
  before: 135,
  minCount: 10,
});

const diff = await client.diffHistory(projectId, 'main.tex', 120, 135, {
  includeContent: false,
  includeUnchanged: false,
});
```

Normalized authors contain only an optional Overleaf user ID and a display
name. Email addresses from the raw response are not exposed. The library and
CLI include changed text by default; callers handling sensitive manuscripts
can set `includeContent: false` or use `--no-content`.

## MCP

- `list_history` lists normalized update groups and accepts `limit`, `before`,
  and `min_count`.
- `diff_history` diffs one path between `from_version` and `to_version`.

MCP diffs default `include_content` and `include_unchanged` to `false`, keeping
document text out of an agent's context unless the caller opts in.

## Version boundaries

Overleaf project-history versions are not Git commits and are not real-time
document OT versions. Never substitute one identifier for another.

Git remains the durable audit and rollback system for this fork. A Git clone
or fetch still imports the current Overleaf snapshot as one commit; the
read-only history commands do not reconstruct historical Git commits. Native
history restoration and `history snapshot-to-git` remain separate, deferred
work.
