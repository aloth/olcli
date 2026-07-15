# Fork baseline report

Recorded on 2026-07-13 and extended as tracked-change milestones were validated.

## Source baseline

- Fork commit: `e1447668ececfd61dd745eb7ef19b970dfe9c8fb`
- Upstream release represented by the checkout: `v0.7.0`
- Local runtime used for this report: Node.js `v25.9.0`, npm `11.12.1`

## Checks

- `npm ci`: passed.
- `npm run build`: passed.
- At the initial baseline, live `test/e2e.sh` was not run because
  `OVERLEAF_SESSION` was not set. Later targeted live results are recorded
  below. The complete legacy upload/push/sync suite remains deferred to a
  second disposable fixture with no comments or tracked changes to preserve.
- `npm audit --omit=dev`: reported one moderate and two high advisories in the
  existing production dependency tree (`ajv`, `fast-uri`, and `undici`). These
  are recorded for a focused dependency update and are not silently rewritten
  as part of the test-foundation work.

During release hardening, `npm audit fix` updated only the compatible
transitive resolutions for those three packages. The full suite passed and
`npm audit --omit=dev` then reported zero vulnerabilities.

Future live results should record the date, Overleaf instance, OT format, test
project shape, and whether another browser client was connected. Never record
credentials, real project identifiers, collaborator emails, or manuscript text.

## Disposable live validation — 2026-07-13

- Instance: Overleaf Cloud.
- Project: dedicated disposable project containing synthetic `main.tex`,
  `comments.tex`, `unicode.tex`, and `nested/chapter.tex` fixtures.
- Authentication: local gitignored `.olauth` with mode `0600`; no credential
  value was logged or copied into repository files.
- Browser client: connected during the tests.
- OT format: `sharejs-text-ot`.
- Permissions: owner; tracked-changes feature and visibility flags enabled.
- Initial tracked-changes state: `false`.
- Real-time comment list: passed with no comments.
- Real-time comment add and subsequent anchored list: passed against the
  synthetic comment marker.
- `changes doctor`: passed, including permission, feature, state, current-user,
  and OT-format detection.
- `changes list`: passed first with no changes, then with a browser-created
  native replacement represented by one insertion and one deletion. The CLI
  returned the native IDs, kinds, author metadata, timestamps, text, locations,
  and source context.
- MCP `get_changes_capabilities` and `list_tracked_changes`: passed through a
  real stdio client using `.olauth`; this also verified the MCP credential
  parser handles `name=value` files consistently with the CLI.
- Browser editing mode was restored after the tracked-change fixture was
  created; the native replacement was left pending for the later
  accept/reject tests.
- The first CLI-created replacement exposed an Overleaf API nuance: a global
  `{ on: false }` write does not remove a temporary per-user review setting.
  The client detected the restoration failure, returned
  `STATE_RESTORE_FAILED`, and did not claim complete success.
- State restoration was corrected to explicitly disable the temporary user
  while preserving the prior global, member, and guest configuration. Unit
  coverage includes boolean and per-user/guest states.
- A second, preconditioned CLI replacement in the nested fixture passed from
  version read through acknowledgment, rejoin, text/range verification, and
  exact state restoration. It returned two native range IDs.
- Overleaf's browser review panel showed that CLI-created nested replacement as
  one human-readable change with the exact old/new passage and native Accept
  and Reject controls. The editor remained in Editing mode afterward.
- The disposable project compiled successfully with the pending tracked
  suggestions. The suggestions remain pending for the accept/reject milestone.
- Selected-ID rejection was live validated on the nested replacement. The CLI
  restored the original wording, removed both requested ranges, observed a
  single document-version increment, and left no nested changes.
- Selected-ID acceptance was live validated on one main-document replacement.
  The revised wording remained, the two requested ranges disappeared, and an
  unrelated pending replacement retained both native IDs. The endpoint changed
  review metadata without incrementing the document text version, which the
  verifier correctly permits.
- Capability detection now reports legacy accept/reject support. Track-changes
  project state remained `false`, and the project compiled after both live
  resolutions.
- A final browser inspection agreed with the CLI verification: the accepted
  main-document replacement no longer appeared in Review, the unrelated
  replacement still had native Accept/Reject controls, and the rejected nested
  replacement left its original source with no remaining suggestions.
- `history-ot` suggestion and resolution operations are covered by independent
  protocol fixtures and tests derived from the official editor schema. No live
  history-OT document was available in this account, so doctor output keeps an
  explicit validation warning for that format.
- The comment-to-change workflow was live validated against the synthetic open
  comment fixture. A dry run proved source-range overlap, the actual operation
  created a native replacement and posted one reply, and a same-operation retry
  did not duplicate either action.
- Pending reconciliation initially exposed a legacy collaboration constraint:
  concurrent sessions could lose a `joinDoc` acknowledgement. Reconciliation
  now serializes and caches per-document reads; the identical live retry passed.
- The test suggestion was rejected to restore the fixture. Reconciliation
  classified it as `rejected` from the original source hash, kept the default
  `never` policy's comment open, and the disposable project compiled afterward.
- The live ledger was stored outside the repository. Inspection confirmed it
  contained hashes and identifiers, not source passages, reply text,
  credentials, or reviewer details.
- Native project-history listing passed against the disposable project,
  including client-side limits and a second page fetched with the returned
  version cursor. Raw author emails are omitted from normalized output.
- A read-only file diff passed for a synthetic fixture. The CLI returned
  inserted, deleted, and unchanged character counts; the MCP metadata-only
  request returned the same changed-chunk kinds without source text.
- MCP `list_history` and `diff_history` registered and passed through a real
  stdio client. No history restoration, label mutation, or Git replay endpoint
  is exposed.
- The MCP server's default `read` policy was live validated: targeted previews
  and default dry runs passed, while an actual tracked suggestion and the
  legacy upload tool both failed with `MCP_REVIEW_POLICY_DENIED` before any
  project mutation.
- A controlled MCP policy round trip passed on the disposable project. In
  `suggest` mode it created and verified one synthetic native insertion and
  restored review state; in `full` mode it rejected exactly the returned ID,
  verified rollback, confirmed the ID disappeared, and compiled. No synthetic
  change was left pending.

## Release-candidate audit — 2026-07-15

- A clean `npm ci` passed on Node.js `v25.9.0` and npm `11.12.1`.
- `npm run verify` passed typecheck, build, 22 test files, and all 95 unit and
  protocol-contract tests.
- `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities.
- `npm pack --dry-run` contained only the intended binaries, declarations,
  source maps, package metadata, security/migration notices, agent skill, and
  Markdown documentation.
- The Agent Skills validator passed, and every local Markdown link target was
  present.
- Safe live checks passed for project info, comment listing, tracked-change
  capability/list reads, history listing, compilation, PDF download, ZIP
  download/integrity, and a pull into a temporary directory.
- A temporary npm installation exposed all three declared binaries, and its
  `git-remote-overleaf` helper completed a read-only clone of the disposable
  project into a temporary Git repository.
- A second disposable project with no collaborator content or review state was
  created specifically for legacy mutation coverage. Its `main.tex` also uses
  `sharejs-text-ot`; creating a new Cloud project therefore did not provide a
  live `history-ot` document.
- The complete legacy E2E suite passed 70/70 from a fresh packed-package
  installation, with zero cleanup failures. Coverage included upload/download,
  ZIP, compilation, PDF and output artifacts, pull, push/dry-run/stale-root
  recovery, bidirectional sync, deletion propagation and `--no-delete`, rename,
  delete, error handling, and Git-remote clone/push/delete.
- The first mutation run exposed that an absolute local upload path was being
  recreated as remote folders. Upload defaults now preserve safe relative
  subfolders but reduce absolute or parent-traversing paths to their basename;
  six unit cases and the clean 70/70 rerun verify the behavior.
- The E2E harness now propagates a local `.olauth` cookie to subprocesses that
  intentionally change directories, requires an explicit mutation gate, and
  deletes or independently verifies every synthetic remote artifact in its
  exit trap.
- A separate gated live probe created synthetic comments before, around, and
  after a targeted replacement. A second collaboration write invalidated the
  prepared version/hash and the stale mutation failed with `VERSION_CONFLICT`;
  after a fresh tracked replacement and its rejection, all three comment
  threads retained the expected file, ordering, and selected text. The probe
  deleted every comment, suggestion, and fixture afterward.
- A simultaneous Chrome-tab rerun remains unavailable because the local Chrome
  control plugin fails during initialization. The live protocol-level
  concurrency test is green, but the browser-specific checkbox stays open.
- The first `dev` push completed the GitHub Actions CI matrix successfully on
  Node.js 18, 20, 22, and 24. Each job installed from the lockfile, audited
  production dependencies, typechecked, ran all tests, built, and inspected the
  package dry run.
