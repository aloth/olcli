# Experimental protocol compatibility

The public Overleaf API does not cover the review and history operations in
this fork. Support below refers to undocumented Overleaf Cloud behavior and
can break independently of package releases.

| Capability | `sharejs-text-ot` | `history-ot` | Live validation |
|------------|-------------------|--------------|-----------------|
| Join/read document | Supported | Supported | ShareJS |
| List comments/ranges | Supported | Supported | ShareJS |
| List native tracked changes | Supported | Supported | ShareJS |
| Targeted tracked suggestion | Supported | Experimental adapter | ShareJS; history-OT contract fixtures |
| Accept/reject explicit IDs | Supported | Experimental adapter | ShareJS; history-OT contract fixtures |
| Comment-linked review workflow | Supported | Depends on mutation adapter | ShareJS |
| Project history list/diff | Independent of document OT type | Independent of document OT type | Overleaf Cloud |

Current ShareJS live validation uses an owner account on a synthetic disposable
project. No live history-OT document was available during the 2026-07-13 test
run, so history-OT mutation remains fail-visible in `changes doctor` and must
not be treated as production-validated.

## Compatibility rules

- Run `changes doctor` for every target document before mutation.
- Never serialize ShareJS operations into a history-OT document or vice versa.
- Require exact source/version preconditions and explicit change IDs.
- Unknown OT types, malformed ranges, missing acknowledgements, repeated
  history cursors, and unfamiliar response shapes fail closed.
- A browser connected to the same project may affect collaboration timing.
- Ordinary `push` is a full-file upload and must not be used for reviewer-facing
  tracked edits.

See [TRACKED-CHANGES.md](TRACKED-CHANGES.md), [HISTORY.md](HISTORY.md), and the
[official Overleaf history API client](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/history/services/api.ts)
for the currently captured contracts.
