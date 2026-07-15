---
name: olcli
description: Operate Overleaf projects through the experimental olcli fork, including listing reviewer comments, creating native tracked suggestions, replying without resolving, compiling, reconciling a text-free review ledger, and inspecting native project history. Use when an agent must address Overleaf feedback with small reviewable edits instead of full-file uploads, or when it needs safe read-only Overleaf inspection through CLI or MCP.
---

# olcli agent workflow

Use the MCP tools for agent-driven review. Use the CLI for interactive setup,
diagnostics, and Git workflows. Treat the Overleaf session cookie as a
password.

## Prepare the local checkout

The experimental npm package is not published yet. Run from this repository:

```bash
cd /absolute/path/to/olcli
npm ci
npm run build
```

Replace `/absolute/path/to/olcli` with this checkout's absolute path.

Keep `.olauth` gitignored at mode `0600`, or provide `OVERLEAF_SESSION` through
a protected MCP environment. Never print credentials or enable raw protocol
logging on a real manuscript.

Start MCP from the repository root so local authentication and the review
ledger resolve predictably:

```bash
OLCLI_EXPERIMENTAL_REVIEW=1 \
OLCLI_MCP_REVIEW_MODE=suggest \
node dist/mcp.js
```

Use `read` for inspection only, `suggest` for tracked suggestions and replies,
and `full` only when the user explicitly authorizes accept/reject, comment
resolution, uploads, renames, or deletion.

## Address an open comment

Follow this sequence for every comment. Do not collapse or reorder mutation
steps.

1. Call `get_mcp_review_policy`. Require `suggestTrackedChanges: true`.
2. Call `list_comments` with:

   ```json
   {"project_id":"<id>","status":"open","include_context":true}
   ```

3. Select one comment and call `get_changes_capabilities` with its document
   path. Stop unless `canSuggest` is true.
4. Choose the smallest exact `old_text` → `new_text` replacement that addresses
   the comment and overlaps its selected range. Preserve LaTeX structure.
5. Call `preview_tracked_change`. If the source match is stale or ambiguous,
   stop and ask for direction or make the target more precise.
6. Generate one stable UUID for the operation. Call `address_review_comment`
   with:

   - the same project, thread, path, old text, and new text;
   - `expected_version` from preview `version`;
   - `expected_text_sha256` from preview `textSha256`;
   - the stable `operation_id`;
   - `resolution_policy: "never"`;
   - `allow_unrelated: false`;
   - `dry_run: true`.

7. Check that the linked preview targets the intended comment and path.
8. Repeat `address_review_comment` with the same values and
   `dry_run: false`.
9. Require `verified: true`, `trackChangesStateRestored: true`, non-empty
   change IDs, and a posted reply.
10. Call `compile`, then `list_tracked_changes` for the document. Confirm every
    returned change ID exists.
11. Leave the comment open and leave accept/reject to collaborators.

Reuse the same `operation_id` only to resume the exact same request after a
partial failure. Never reuse it for different text or a different thread.

## Mutation rules

- Never use `push_file`, `olcli push`, or `olcli sync` for reviewer-facing
  edits. Those are full-file operations and do not create native tracked
  suggestions.
- Never weaken or omit version/hash preconditions after a conflict.
- Never retry automatically after an uncertain acknowledgment. Re-list state
  or run reconciliation first.
- Never resolve a comment by default. Keep `resolution_policy: "never"` unless
  the user explicitly grants resolution authority and enables `full` mode.
- Never accept or reject all changes implicitly. Use explicit native IDs.
- Keep edits small. Avoid delete-all/reinsert-all operations.
- Compile after mutations and report verification failures visibly.

## Accept or reject changes

Use only in explicitly authorized `full` mode.

1. Call `list_tracked_changes` and select explicit IDs.
2. Call `inspect_tracked_document` for the current text-free `version` and
   `textSha256`.
3. Call `accept_tracked_changes` or `reject_tracked_changes` with those
   preconditions and `dry_run: true`.
4. Review the exact IDs, change kinds, text, and expected result hash.
5. Repeat with `dry_run: false`.
6. Require `verified: true`, re-list changes, and compile.

## Reconcile and audit

- Use `review_status` to inspect the text-free `.olcli-review.json` ledger.
- Use `reconcile_review` with `dry_run: true` by default.
- Require `full` mode and explicit user authority before reconciliation writes
  or automatic comment resolution.
- Keep Git as the durable audit and rollback record. Overleaf history versions
  are not Git commits or document OT versions.

## Inspect history

Use `list_history` for normalized native update groups. Follow `nextBefore` as
the `before` cursor. Use `diff_history` with `include_content: false` unless the
task genuinely requires inserted/deleted source text. History restoration and
replay into Git are not supported.

## CLI fallback

Use these commands for diagnostics or when MCP is unavailable:

```bash
olcli comments list "Paper" --status open --context 3 --json
olcli changes doctor "Paper" --file main.tex
olcli changes list "Paper" --file main.tex --json
olcli changes suggest main.tex "Paper" \
  --old "Exact old text" --new "Exact new text" --dry-run --json
OLCLI_EXPERIMENTAL_REVIEW=1 olcli changes suggest main.tex "Paper" \
  --old "Exact old text" --new "Exact new text" \
  --expected-version <version> --expected-sha256 <sha256> --json
olcli compile "Paper"
```

## Read detailed references only when needed

- Read [docs/MCP.md](docs/MCP.md) for tool schemas and MCP client setup.
- Read [docs/REVIEW-WORKFLOW.md](docs/REVIEW-WORKFLOW.md) for ledger states,
  recovery, and comment-resolution policies.
- Read [docs/TRACKED-CHANGES.md](docs/TRACKED-CHANGES.md) for OT adapters and
  tracked-change semantics.
- Read [docs/HISTORY.md](docs/HISTORY.md) for pagination and diff behavior.
- Read [docs/PROTOCOL-COMPATIBILITY.md](docs/PROTOCOL-COMPATIBILITY.md) before
  using a document that reports `history-ot`.
- Read [SECURITY.md](SECURITY.md) before enabling `full` mode or unsafe logs.
