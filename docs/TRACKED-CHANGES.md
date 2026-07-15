# Native tracked changes

The review commands use Overleaf's real-time collaboration protocol for small,
reviewer-facing edits. They do not upload a replacement file.

## Compatibility

| Capability | `sharejs-text-ot` | `history-ot` |
|---|---|---|
| List changes | Live validated | Contract tested |
| Targeted insert/delete/replace | Live validated | Contract tested |
| Accept explicit IDs | Live validated | Contract tested |
| Reject explicit IDs | Live validated | Contract tested |
| Non-BMP insertion | Supported | Refused before mutation |
| Change identity | Native range ID | Editor-compatible, position-derived ID |

`history-ot` uses structured text operations. Tracked insertions carry explicit
`insert` tracking metadata; tracked deletions retain text with `delete`
tracking metadata. Accept/reject either removes snapshot text or clears its
tracking metadata. This behavior is independently encoded from the current
[Overleaf review actions](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/review-panel/context/ranges-context.tsx)
and [history-OT editor extension](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/source-editor/extensions/history-ot.ts).

The current disposable Overleaf Cloud project exposes `sharejs-text-ot`, so
`history-ot` writes remain fail-visible in `changes doctor` until they can also
be exercised live. Its operation shapes are covered by sanitized fixtures and
unit tests. The implementation does not copy Overleaf's AGPL source code.

## Safe workflow

```bash
olcli changes doctor "Paper" --file main.tex --json
olcli changes list "Paper" --file main.tex --json

olcli changes suggest main.tex "Paper" \
  --old "Unique original text" \
  --new "Unique revised text" \
  --dry-run --json

olcli changes accept main.tex <change-id> --project "Paper" --dry-run --json
olcli changes reject main.tex <change-id> --project "Paper" --dry-run --json
```

For every mutation, carry the preview's `version` and `textSha256` into
`--expected-version` and `--expected-sha256`. The command re-reads immediately
before submission, never retries a conflict automatically, and verifies text,
requested-range removal, and preservation of unrelated legacy range IDs.

Accept/reject always requires explicit IDs. There is intentionally no `--all`
operation.
