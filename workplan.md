# Work Plan: Native Overleaf Review Automation for `xyin-anl/olcli`

**Status:** Local release candidate; follow-up validation remains
**Repository:** `xyin-anl/olcli`
**Upstream:** `aloth/olcli`
**Baseline:** upstream `v0.7.0` / forked from the July 2026 codebase
**Last updated:** 2026-07-15
**Primary objective:** Add safe, native Overleaf tracked-change workflows while preserving the existing CLI, library, comments, sync, compile, Git-remote, and MCP capabilities.

**Audit status (2026-07-15):** The agent-review MVP is implemented and has
passed unit, protocol-contract, package, security, and targeted live tests on a
disposable Overleaf Cloud project using `sharejs-text-ot`. The implementation
for `history-ot` is contract-tested but has not been mutation-tested against a
live project because the available account/project did not expose that format.
The complete legacy upload/sync E2E suite was not run against the review fixture
because whole-file uploads could disturb its tracked changes and comment
anchors. Remaining follow-ups are listed in Section 33.

---

## 1. Executive summary

This fork should become a review-oriented Overleaf client that can:

1. Read comments and their anchored source context.
2. Make small document edits through Overleaf's real-time collaboration protocol.
3. Submit those edits as native Overleaf tracked changes.
4. List tracked changes with stable IDs and source locations.
5. Accept or reject selected tracked changes.
6. Reply to and resolve comment threads under an explicit policy.
7. Expose the same workflow through the CLI, TypeScript library, and MCP server.
8. Keep Git—not Overleaf's native history—as the durable, auditable record.

The safest development strategy is incremental:

- Preserve existing behavior first.
- Extract and test the real-time document layer.
- Add read-only tracked-change inspection.
- Add one targeted suggestion operation with strong preconditions.
- Support both Overleaf OT formats behind adapters.
- Add accept/reject only after change listing and mutation verification are reliable.
- Add agent automation last.

Do not begin with whole-file tracked replacements, bulk accept/reject, automatic comment resolution, or native history restoration.

---

## 2. Product vision

The intended end-to-end workflow is:

```text
reviewer leaves an Overleaf comment
        ↓
olcli reads the comment and source anchor
        ↓
developer/agent prepares a minimal source patch
        ↓
the patch is committed to Git
        ↓
olcli submits the same patch as a native Overleaf suggestion
        ↓
olcli verifies the resulting tracked-change IDs
        ↓
olcli replies to the comment with a concise summary
        ↓
human accepts or rejects the suggestion in Overleaf
        ↓
olcli optionally reconciles the comment and resolves it
```

Git provides:

- durable commit history;
- rollback;
- reviewable diffs;
- branch and pull-request workflows;
- a stable record even if Overleaf changes internal APIs.

Overleaf provides:

- live collaboration;
- native comments;
- review-panel tracked changes;
- acceptance and rejection in the editor;
- cloud compilation.

---

## 3. Definition of success

The project is successful when all of the following are true on a disposable Overleaf Cloud project:

- [x] `olcli changes doctor` identifies the document OT type and whether tracked changes are available.
- [x] `olcli changes list` returns existing tracked changes with IDs, type, author metadata when available, text, and source position.
- [x] `olcli changes suggest` creates a small native tracked replacement visible in Overleaf's review panel.
- [x] The suggestion is generated only when the expected source text and document version still match.
- [ ] A concurrent browser edit causes a clean conflict error rather than an overwrite.
- [x] Existing comment anchors before, inside, and after the edited range remain valid or fail in a detectable way.
- [x] `olcli changes accept` accepts only the requested change IDs.
- [x] `olcli changes reject` rejects only the requested change IDs.
- [x] Every mutation is verified by re-reading the document and ranges.
- [x] Track-changes project state is restored to its exact prior value after an operation.
- [x] CLI, library, and MCP responses expose the same structured result fields.
- [x] A Git commit can be linked to the resulting Overleaf change IDs.
- [ ] Unit, contract, and live end-to-end tests cover both supported OT formats.
- [x] Existing comments, sync, pull, push, compile, PDF, and Git-remote behavior remain compatible.

---

## 4. Scope

### 4.1 Priority 0: required for the first useful release

- Safe real-time document session abstraction.
- Capability and OT-type detection.
- Read-only listing of tracked changes.
- Targeted tracked insert, delete, and replacement.
- Version and source-text preconditions.
- Post-mutation verification.
- Exact restoration of track-changes state.
- Structured CLI and library APIs.
- Tests and secret-safe diagnostics.

### 4.2 Priority 1: required for the complete review workflow

- Accept selected tracked changes.
- Reject selected tracked changes.
- Comment-to-change workflow ledger.
- Reply to comments with change and Git references.
- Optional comment resolution policies.
- MCP tools for listing, suggesting, accepting, and rejecting.
- Read-only history listing and document diffs.

### 4.3 Priority 2: useful later

- Minimal multi-hunk diff generation from complete file content.
- Batch suggestions across several files.
- Reconciliation of accepted changes with comment threads.
- Git notes or commit trailers for Overleaf metadata.
- A machine-readable protocol compatibility report.
- Self-hosted Overleaf compatibility matrix.
- History snapshots imported into a local Git branch.

### 4.4 Explicit non-goals for the initial releases

- Restoring arbitrary Overleaf native history versions.
- Replaying all existing Overleaf history into Git.
- Replacing Git with Overleaf history.
- Automatically accepting an AI-generated suggestion.
- Automatically resolving comments by default.
- Retrying mutations automatically after a version conflict.
- Creating a tracked whole-file delete-and-reinsert operation.
- Supporting undocumented protocol variants without explicit detection.
- Bypassing account entitlements or Overleaf feature restrictions.

---

## 5. Design decisions

| Decision | Chosen approach | Reason |
|---|---|---|
| Durable history | Git | Stable, auditable, and independent of undocumented Overleaf internals |
| Review presentation | Native Overleaf tracked changes | Reviewers can accept/reject in the existing UI |
| Document mutation transport | Real-time OT session | Preserves collaboration semantics better than file replacement |
| Concurrency control | Optimistic version and source preconditions | Prevents silent overwrites |
| Automatic retry | Disabled for mutations | A retry against new content could edit the wrong text |
| Default comment policy | Reply but leave open | A suggestion is not the same as an accepted fix |
| OT compatibility | Adapter per OT type | Legacy ShareJS and history-OT have different representations |
| Public API model | Typed service layer shared by CLI/MCP | Prevents three divergent implementations |
| Internal protocol status | Experimental and versioned | Endpoints and frames are undocumented and can change |
| Full-file upload | Keep for ordinary sync, not review edits | Upload is useful, but not the correct primitive for native suggestions |
| Protocol reference | Observe behavior and wire format | Avoid copying incompatible licensed code |
| Release strategy | Small feature branches and upstreamable PRs | Reduces long-term fork maintenance |

---

## 6. Current repository baseline

The fork currently inherits these useful building blocks:

- `src/client.ts`
  - authentication and CSRF handling;
  - HTTP requests;
  - project and file operations;
  - Socket.IO v0.9 polling helpers;
  - document joining for comment ranges;
  - comments list/add/reply/resolve/reopen/delete;
  - compile and output download.

- `src/cli.ts`
  - project resolution;
  - pull, push, and sync;
  - comments command group;
  - JSON output options for several commands.

- `src/mcp.ts`
  - a stdio MCP server;
  - lazy authenticated client creation;
  - typed Zod input schemas;
  - comments and file tools.

- `src/index.ts`
  - public TypeScript exports.

- `test/e2e.sh`
  - live end-to-end testing for existing file, sync, and compile behavior.

- `package.json`
  - Node 18+;
  - TypeScript build;
  - package/library/CLI/MCP exports.

Important gaps:

- Real-time document methods are private and comment-specific.
- `client.ts` is already large and will become harder to maintain if tracked changes are added directly.
- There is no proper unit-test script in the package.
- The current lint script is not backed by a complete checked-in lint setup.
- Mutating document text is primarily file-upload based.
- There is no tracked-change domain model.
- There is no explicit version-conflict error taxonomy.
- There is no structured capability report for track changes.
- There is no safe review workflow ledger.
- Verbose diagnostics must be reviewed for accidental exposure of cookies, CSRF tokens, comments, or document content.

---

## 7. Technical background and protocol assumptions

Treat every item in this section as an assumption to verify with tests.

### 7.1 Joined document data

A joined document can report an OT type such as:

```ts
type OverleafOtType = 'sharejs-text-ot' | 'history-ot';
```

The join response should be normalized into one internal snapshot regardless of raw format.

### 7.2 Legacy ShareJS-style edits

The legacy protocol commonly represents text edits as operations resembling:

```ts
type LegacyTextOperation =
  | { i: string; p: number }  // insert
  | { d: string; p: number }  // delete
  | { c: string; p: number; t: string }; // comment range
```

A tracked operation has been observed with update metadata containing a track-change seed:

```ts
{
  doc: docId,
  op: operations,
  v: version,
  meta: { tc: trackChangeSeed }
}
```

Do not assume this is sufficient for every current document format.

### 7.3 History-OT

Current Overleaf frontend code has a distinct history-OT path with structured snapshots, tracked ranges, and operations that can clear tracking metadata. It must be implemented as a separate adapter. Do not serialize ordinary ShareJS operations and assume they are valid history-OT operations.

### 7.4 Track-changes project state

Track changes can be represented as:

- on for everyone;
- on for guests;
- on for selected members;
- off.

The implementation must preserve the complete prior state rather than simply turning the current user off afterward.

### 7.5 Accept and reject are not symmetric

For a legacy tracked-change range:

- accepting an insertion generally keeps the inserted text and removes the tracking marker;
- accepting a deletion generally removes the tracked-deleted text/range;
- rejecting an insertion removes the inserted text;
- rejecting a deletion restores the deleted text.

For history-OT, acceptance and rejection may require snapshot operations that clear tracking properties or remove text. Build this from captured behavior and verified fixtures rather than intuition.

---

## 8. Target architecture

### 8.1 Proposed source tree

Add new modules without immediately rewriting unrelated existing functionality:

```text
src/
  client.ts                       # existing high-level client; gradually delegates
  cli.ts                          # existing CLI entry; registers command modules
  index.ts                        # public exports
  mcp.ts                          # existing MCP entry; delegates to services

  errors/
    codes.ts
    olcli-error.ts
    serialize-error.ts

  logging/
    logger.ts
    redact.ts

  realtime/
    types.ts
    transport.ts
    socketio-v09-transport.ts
    project-session.ts
    document-session.ts
    protocol-fixtures.ts

  realtime/adapters/
    adapter.ts
    sharejs-text-adapter.ts
    history-ot-adapter.ts
    unsupported-adapter.ts

  changes/
    types.ts
    capability-service.ts
    range-parser.ts
    text-matcher.ts
    minimal-diff.ts
    track-changes-state.ts
    changes-service.ts
    verification.ts

  history/
    types.ts
    history-service.ts

  review/
    types.ts
    ledger.ts
    review-service.ts
    git-metadata.ts

  commands/
    changes.ts
    history.ts
    review.ts

  mcp-tools/
    changes.ts
    history.ts
    review.ts

test/
  unit/
  contract/
  fixtures/
    protocol/
      sharejs-text/
      history-ot/
  e2e/
    live/
    helpers/
```

### 8.2 Migration rule

Do not split the entire repository in one refactor.

Use this sequence:

1. Add the new real-time abstractions.
2. Make existing comments use them.
3. Verify no comment regression.
4. Add tracked-change services.
5. Move additional command groups only when touched.

### 8.3 Layer responsibilities

#### Transport layer

Responsible for:

- Socket.IO v0.9 handshake;
- load-balancer cookies;
- WebSocket or polling transport;
- heartbeat;
- event framing;
- acknowledgments;
- timeouts;
- disconnect cleanup;
- raw event capture in sanitized debug mode.

It must not know about comments or tracked changes.

#### Project session

Responsible for:

- connecting to a project;
- joining the project;
- exposing the file tree and current user/project metadata;
- locating documents by normalized path;
- creating document sessions.

#### Document session

Responsible for:

- joining and leaving a document;
- exposing version, OT type, snapshot, and ranges;
- submitting an operation with an expected version;
- receiving acknowledgment or conflict;
- refreshing and verifying state.

#### OT adapter

Responsible for:

- parsing a raw joined snapshot;
- listing normalized tracked changes;
- building tracked insert/delete/replace operations;
- building accept/reject operations;
- validating adapter-specific invariants.

#### Changes service

Responsible for:

- capability checks;
- source-text matching;
- preconditions;
- track-changes state save/restore;
- adapter selection;
- mutation submission;
- post-mutation verification;
- structured results.

#### Review service

Responsible for:

- comment lookup;
- suggestion creation;
- optional Git metadata;
- replies;
- explicit resolution policy;
- local workflow ledger.

---

## 9. Core TypeScript interfaces

Use stable domain types even while the wire protocol remains experimental.

```ts
export type OverleafOtType =
  | 'sharejs-text-ot'
  | 'history-ot'
  | `unknown:${string}`;

export interface DocumentSnapshot {
  projectId: string;
  docId: string;
  path: string;
  version: number;
  otType: OverleafOtType;
  text: string;
  textSha256: string;
  rawRanges: unknown;
  joinedAt: string;
}

export interface MutationPrecondition {
  expectedVersion?: number;
  expectedTextSha256?: string;
  expectedText?: {
    position: number;
    value: string;
  };
}

export type TrackedChangeKind = 'insert' | 'delete' | 'replace-part';

export interface TrackedChange {
  id: string;
  docId: string;
  path: string;
  kind: TrackedChangeKind;
  position: number;
  text: string;
  authorId?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface SuggestChangeInput {
  projectId: string;
  filePath: string;
  oldText: string;
  newText: string;
  occurrence?: number;
  precondition?: MutationPrecondition;
  dryRun?: boolean;
}

export interface SuggestionPreview {
  projectId: string;
  docId: string;
  path: string;
  otType: OverleafOtType;
  version: number;
  position: number;
  oldText: string;
  newText: string;
  operations: NormalizedTextOperation[];
  expectedResultSha256: string;
}

export interface SuggestionResult extends SuggestionPreview {
  beforeVersion: number;
  afterVersion: number;
  changeIds: string[];
  verified: boolean;
  trackChangesStateRestored: boolean;
}

export interface ChangeMutationInput {
  projectId: string;
  docId: string;
  changeIds: string[];
  expectedVersion?: number;
  dryRun?: boolean;
}

export interface ChangeMutationResult {
  action: 'accept' | 'reject';
  projectId: string;
  docId: string;
  requestedChangeIds: string[];
  remainingChangeIds: string[];
  beforeVersion: number;
  afterVersion: number;
  verified: boolean;
}

export interface ChangesCapabilities {
  projectId: string;
  docId?: string;
  path?: string;
  canWrite: boolean;
  featureAvailable: boolean;
  trackChangesStateReadable: boolean;
  currentUserId?: string;
  otType?: OverleafOtType;
  canList: boolean;
  canSuggest: boolean;
  canAccept: boolean;
  canReject: boolean;
  reasons: string[];
}
```

### 9.1 Adapter interface

```ts
export interface TrackedChangesAdapter {
  readonly otType: OverleafOtType;

  parseSnapshot(raw: JoinedDocumentRaw): DocumentSnapshot;

  listChanges(snapshot: DocumentSnapshot): TrackedChange[];

  buildTrackedReplacement(
    snapshot: DocumentSnapshot,
    position: number,
    oldText: string,
    newText: string,
    trackChangeSeed: string
  ): AdapterMutation;

  buildAccept(
    snapshot: DocumentSnapshot,
    changes: TrackedChange[]
  ): AdapterMutation;

  buildReject(
    snapshot: DocumentSnapshot,
    changes: TrackedChange[]
  ): AdapterMutation;

  verifySnapshot(snapshot: DocumentSnapshot): void;
}
```

### 9.2 Error taxonomy

Create stable error codes and include them in JSON/MCP output:

```ts
export type OlcliErrorCode =
  | 'AUTH_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'TRACK_CHANGES_UNAVAILABLE'
  | 'TRACK_CHANGES_STATE_UNREADABLE'
  | 'PROJECT_NOT_FOUND'
  | 'DOCUMENT_NOT_FOUND'
  | 'AMBIGUOUS_MATCH'
  | 'SOURCE_TEXT_NOT_FOUND'
  | 'SOURCE_MISMATCH'
  | 'VERSION_CONFLICT'
  | 'UNSUPPORTED_OT_TYPE'
  | 'SOCKET_HANDSHAKE_FAILED'
  | 'SOCKET_TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'MUTATION_REJECTED'
  | 'VERIFICATION_FAILED'
  | 'STATE_RESTORE_FAILED'
  | 'PARTIAL_FAILURE';
```

Suggested CLI exit codes:

| Exit code | Meaning |
|---:|---|
| 0 | Success |
| 2 | Invalid input or failed source precondition |
| 3 | Authentication, entitlement, or permission failure |
| 4 | Version conflict |
| 5 | Network or protocol failure |
| 6 | Mutation submitted but verification or cleanup failed |

---

## 10. CLI specification

### 10.1 Capability inspection

```bash
olcli changes doctor [project] --file main.tex
olcli changes doctor [project] --file main.tex --json
```

Output should include:

- project and document IDs;
- normalized file path;
- current user ID when available;
- write permission;
- track-changes feature availability;
- current track-changes state;
- document OT type;
- supported actions;
- clear reasons for unsupported actions.

### 10.2 List tracked changes

```bash
olcli changes list [project]
olcli changes list [project] --file main.tex
olcli changes list [project] --file main.tex --context 2
olcli changes list [project] --json
```

Required fields per change:

- change ID;
- document ID and path;
- insertion or deletion;
- position;
- affected text;
- line and column;
- author and timestamp when available;
- source context;
- OT type.

### 10.3 Suggest a targeted replacement

```bash
olcli changes suggest main.tex \
  --old "the old wording" \
  --new "the revised wording" \
  [project]
```

Options:

```text
--occurrence <n>          use the nth match; default requires uniqueness
--expected-version <n>    refuse unless the joined document version matches
--expected-sha256 <hash>  refuse unless current text hash matches
--dry-run                 print the planned operation without submitting
--json                    structured output
--context <n>             include source context in preview/result
```

Rules:

- `--old` and `--new` are mandatory for the first implementation.
- The default requires exactly one match.
- `--occurrence` must be explicit when the match is non-unique.
- Empty `--old` is allowed only for an insertion when `--position` is provided.
- Empty `--new` is allowed for a deletion.
- The command must recheck text and version immediately before submission.
- No automatic retry after conflict.
- The command must verify new tracked-change IDs after submission.
- The command must restore the exact previous track-changes state.

### 10.4 Accept and reject

```bash
olcli changes accept main.tex <change-id...> --project <project>
olcli changes reject main.tex <change-id...> --project <project>
```

Options:

```text
--expected-version <n>
--expected-sha256 <hash>
--project <project>
--dry-run
--json
```

Safety rules:

- Require explicit change IDs.
- Do not add `--all` until selected-ID behavior is well tested.
- Verify all requested IDs exist before submission.
- Refuse mixed-document IDs in one operation.
- Re-read after submission and confirm requested IDs disappeared.
- Verify expected text effects, not only range disappearance.

### 10.5 Track-changes state inspection

```bash
olcli changes state [project] --json
```

A write command to change project-wide state is not required for the first release. Internal temporary changes must be restored automatically.

### 10.6 History

```bash
olcli history list [project] --limit 50 --json
olcli history diff main.tex --from <version> --to <version> [project]
```

Initial history support is read-only.

### 10.7 Review workflow

```bash
olcli review address <thread-id> \
  --file main.tex \
  --old "old text" \
  --new "new text" \
  --reply "Proposed a tracked revision." \
  [project]
```

Resolution policy:

```text
--resolve never          default
--resolve after-suggest  explicit, potentially premature
--resolve after-accept   record for later reconciliation
```

The default must be `never`.

---

## 11. Programmatic library API

Expose services through `src/index.ts`:

```ts
import {
  OverleafClient,
  ChangesService,
  HistoryService,
  ReviewService,
  type SuggestChangeInput,
  type SuggestionResult,
  type TrackedChange,
} from '@xyin-anl/olcli';
```

Proposed methods:

```ts
client.getChangesCapabilities(projectId, filePath?)
client.listTrackedChanges(projectId, options?)
client.previewTrackedSuggestion(input)
client.suggestTrackedChange(input)
client.acceptTrackedChanges(input)
client.rejectTrackedChanges(input)
client.listHistory(projectId, options?)
client.diffHistory(projectId, filePath, from, to)
client.addressReviewComment(input)
```

Implementation rule: CLI and MCP must call these methods. They must not reimplement protocol logic.

---

## 12. MCP tool specification

Add read tools first:

```text
get_changes_capabilities
list_tracked_changes
preview_tracked_change
list_history
diff_history
```

Then add mutation tools:

```text
suggest_tracked_change
accept_tracked_changes
reject_tracked_changes
address_review_comment
```

### 12.1 MCP mutation safety

Every mutation tool must accept:

- `project_id`;
- `file_path` or `doc_id`;
- source precondition;
- optional `expected_version`;
- `dry_run`.

Recommended environment policy:

```text
OLCLI_MCP_REVIEW_MODE=read       # read-only
OLCLI_MCP_REVIEW_MODE=suggest    # suggestions and replies, no accept/reject
OLCLI_MCP_REVIEW_MODE=full       # explicit full mutation access
```

Default new tracked-change tools to `read` or `suggest`, not `full`.

Do not combine suggestion, acceptance, and comment resolution into a single opaque MCP call. `address_review_comment` may orchestrate suggestion and reply, but acceptance remains separate.

---

## 13. Local review ledger

Create a hidden, non-uploaded project file:

```text
.olcli-review.json
```

Proposed schema:

```json
{
  "schemaVersion": 1,
  "projectId": "PROJECT_ID",
  "entries": [
    {
      "operationId": "uuid",
      "threadId": "THREAD_ID",
      "docId": "DOC_ID",
      "path": "main.tex",
      "sourceVersion": 104,
      "sourceSha256": "…",
      "changeIds": ["…"],
      "gitCommit": "…",
      "createdAt": "2026-07-13T00:00:00.000Z",
      "state": "suggested",
      "resolutionPolicy": "after-accept"
    }
  ]
}
```

Requirements:

- hidden files remain excluded from normal push/sync;
- writes are atomic;
- schema is versioned;
- no session cookie, CSRF token, document body, or reviewer email is stored;
- corrupt ledger files are backed up and reported rather than overwritten;
- operation IDs make retries idempotent where possible.

State transitions:

```text
prepared → suggested → accepted | rejected | superseded
                         ↓
                 comment-resolved
```

---

## 14. Git metadata convention

Use commit trailers rather than inventing a custom Git object format:

```text
Overleaf-Project: <project-id>
Overleaf-Document: <doc-id>
Overleaf-Thread: <thread-id>
Overleaf-Changes: <id1>,<id2>
Overleaf-Source-Version: <version>
```

Possible helper command later:

```bash
olcli review annotate-commit <commit> --operation <operation-id>
```

Do not require Git for basic CLI operation. When Git is present, detect it and offer metadata integration.

---

## 15. Repository and branch setup

### 15.1 Configure the upstream remote

```bash
git clone https://github.com/xyin-anl/olcli.git
cd olcli
git remote add upstream https://github.com/aloth/olcli.git
git fetch upstream
git checkout main
git rebase upstream/main
```

### 15.2 Tag the fork baseline

```bash
git tag fork-base-v0.7.0
git push origin fork-base-v0.7.0
```

Verify the tag points to the exact commit inherited from upstream.

### 15.3 Branch strategy

The fork owner selected `dev` as the integration branch for the experimental
release candidate. Keep `main` as the stable/upstream-aligned branch and create
short-lived implementation branches from `dev` when further work is needed:

```text
chore/test-foundation
refactor/realtime-session
feat/changes-list
feat/changes-suggest
feat/history-ot
feat/changes-accept-reject
feat/review-workflow
feat/mcp-review
```

Do not commit unreviewed protocol experiments directly to `main`.

### 15.4 Recommended labels

```text
area:realtime
area:tracked-changes
area:comments
area:history
area:mcp
area:security
area:testing
protocol:sharejs
protocol:history-ot
kind:research
kind:refactor
kind:feature
kind:bug
blocked:protocol
upstream-candidate
```

---

# 16. Milestone plan

## Milestone 0 — Baseline, governance, and reproducibility

### Objective

Create a known-good baseline before changing protocol behavior.

### Tasks

- [x] Add this `workplan.md` at repository root.
- [x] Add `docs/UPSTREAM.md` with instructions for syncing from `aloth/olcli`.
- [x] Record the upstream baseline commit in `docs/UPSTREAM.md`.
- [x] Run `npm ci`.
- [x] Run `npm run build`.
- [x] Run existing E2E tests on a disposable project.
- [x] Record current passing/failing behavior without changing it.
- [x] Create `fork-base-v0.7.0` locally. Push it only with explicit release/repository approval.
- [ ] Enable branch protection on `main` if practical.
- [ ] Require build and unit-test checks before merge.
- [ ] Create GitHub issues from the backlog in Section 27.

### Deliverables

- `workplan.md`
- `docs/UPSTREAM.md`
- baseline tag
- initial CI workflow
- baseline test report

### Exit criteria

- Clean checkout builds on supported Node versions.
- Existing functionality is demonstrated on a disposable project.
- The fork can be rebased onto upstream without local protocol changes yet.

---

## Milestone 1 — Test foundation and secret-safe diagnostics

### Objective

Make protocol work testable before adding features.

### Tasks

- [x] Add a unit-test framework.
- [x] Use Vitest for TypeScript unit and contract tests.
- [x] Add scripts for unit tests, contract tests, typechecking, and the existing live E2E suite. Add `test:e2e:review` with the tracked-suggestion milestone, when that script can exercise a real command safely.

```json
{
  "test": "vitest run",
  "test:unit": "vitest run test/unit",
  "test:contract": "vitest run test/contract",
  "test:e2e": "bash test/e2e.sh"
}
```

- [x] Remove the misleading lint script until a working lint configuration is added.
- [x] Add `npm run typecheck`.
- [x] Add a redacting logger.
- [x] Mask:
  - `Cookie`;
  - session cookie values;
  - CSRF tokens;
  - authorization headers;
  - emails unless explicitly requested;
  - document text in default debug logs.
- [x] Make protocol frame logging opt-in through an unsafe diagnostic flag.
- [x] Add a fixture sanitizer utility.
- [x] Create a sanitized protocol fixture format.
- [x] Add unit tests for existing comment range parsing.
- [x] Add characterization tests around existing Socket.IO payload decoding.
- [x] Split live E2E tests from default CI.

### Deliverables

- test harness
- CI test job
- logger/redaction module
- fixture sanitizer
- initial characterization tests

### Exit criteria

- `npm test` runs real tests.
- CI fails on unit-test failure.
- Verbose mode does not print session or CSRF secrets.
- Existing comments behavior is covered before refactoring.

---

## Milestone 2 — Extract the real-time collaboration core

### Objective

Create a reusable, testable session layer without changing user-visible behavior.

### Tasks

- [x] Define the initial `OverleafOtType`, joined-document, and project-session transport types. Complete public snapshot types with `DocumentSession`.
- [x] Extract Socket.IO framing and acknowledgment parsing from `client.ts`.
- [x] Implement `SocketIoV09Transport`.
- [x] Implement heartbeat and deterministic cleanup.
- [x] Capture and update load-balancer cookies.
- [x] Implement `ProjectSession`.
- [x] Implement path-to-document lookup.
- [x] Implement `DocumentSession.join()`.
- [x] Normalize:
  - document ID;
  - document version;
  - OT type;
  - current text;
  - raw ranges.
- [x] Implement `submit()` with expected version.
- [x] Convert timeout and version errors into stable `OlcliError` codes.
- [x] Implement `refresh()`.
- [x] Refactor comments listing and adding to use the new session.
- [x] Keep the existing public comment methods as compatibility wrappers over the new session layer.
- [x] Add unit tests for framing, ack correlation, timeout, disconnect, and cleanup.
- [x] Add contract tests using sanitized synthetic join/ack fixtures. Replace or supplement these only with captures from a disposable live project.

### Deliverables

- `src/realtime/*`
- compatibility wrappers in `OverleafClient`
- comments regression tests

### Exit criteria

- Existing comments commands produce equivalent results.
- Session logic has no comments-specific branches.
- A failed operation always closes or releases its document/project session.
- Version conflict is distinguishable from timeout.

---

## Milestone 3 — Capability detection and read-only tracked-change listing

### Objective

Understand both document formats before mutating them.

### Tasks

- [x] Implement `ChangesCapabilities`.
- [x] Detect write permission.
- [x] Detect track-changes feature availability.
- [x] Read complete track-changes state.
- [x] Detect current user ID.
- [x] Detect document OT type.
- [x] Implement `TrackedChangesAdapter` interface.
- [x] Implement a no-mutation unsupported adapter.
- [x] Parse legacy change ranges into `TrackedChange`.
- [x] Parse history-OT tracked changes into `TrackedChange`.
- [x] Preserve raw data only behind an explicit debug option.
- [x] Map character position to line/column.
- [x] Build optional source context.
- [x] Add `olcli changes doctor`.
- [x] Add `olcli changes list`.
- [x] Add library methods.
- [x] Add read-only MCP tools.
- [ ] Test documents with:
  - [x] no changes;
  - [x] one insertion;
  - [x] one deletion;
  - [x] replacement represented as multiple ranges;
  - [ ] overlapping/adjacent changes;
  - [x] multiple authors;
  - [x] non-ASCII text.

### Deliverables

- capability service
- adapter interface
- both read-only parsers
- `changes doctor`
- `changes list`

### Exit criteria

- A change visible in Overleaf's review panel appears in CLI JSON with the same identity.
- Unknown OT types fail with `UNSUPPORTED_OT_TYPE`.
- Listing performs no mutation.
- Both supported formats have fixtures and tests.

---

## Milestone 4 — Targeted suggestion MVP

### Objective

Create a single native tracked insert/delete/replacement safely.

### Tasks

- [x] Implement exact text matching.
- [x] Require uniqueness by default.
- [x] Implement explicit `occurrence`.
- [x] Implement line/column conversion.
- [x] Implement SHA-256 source hashing.
- [x] Implement dry-run preview.
- [x] Implement track-change seed generation.
- [x] Implement a state manager:
  - read full prior state;
  - enable only as required;
  - restore exact prior state in `finally`;
  - report restoration failure separately.
- [x] Implement tracked mutation for the OT format used by the primary live test project.
- [x] Re-read immediately before mutation.
- [x] Check version, hash, and matched source.
- [x] Submit once.
- [x] Wait for acknowledgment.
- [x] Rejoin/re-read after mutation.
- [x] Compare before/after range sets.
- [x] Return newly created change IDs.
- [x] Verify expected text outcome.
- [x] Add `olcli changes suggest`.
- [x] Add programmatic API.
- [x] Add live E2E test behind explicit mutation permission.

### Deliverables

- text matcher
- state manager
- first mutating adapter
- suggestion service and command
- verification service

### Exit criteria

- A targeted replacement appears as native tracked changes in Overleaf.
- Dry-run and actual mutation describe the same intended edit.
- Ambiguous text is rejected.
- Concurrent edits produce `VERSION_CONFLICT` or `SOURCE_MISMATCH`.
- Newly created change IDs are returned and verified.
- Previous project track-changes state is restored.

---

## Milestone 5 — Dual OT-format suggestion support

### Objective

Support both `sharejs-text-ot` and `history-ot` for suggestions.

### Tasks

- [x] Complete legacy ShareJS tracked mutation adapter.
- [x] Complete history-OT tracked mutation adapter.
- [x] Create separate fixtures for each wire format.
- [x] Verify seed and ID behavior.
- [x] Verify insert-only operation.
- [x] Verify delete-only operation.
- [x] Verify replacement.
- [x] Verify adjacent operations.
- [x] Verify edits around comments.
- [x] Verify Unicode offsets.
- [x] Add adapter compatibility table to docs.
- [x] Add `changes doctor` warnings for partially supported formats.

### Deliverables

- two mutating adapters
- compatibility matrix
- dual-format E2E tests

### Exit criteria

- The same CLI input produces equivalent review-panel behavior on both formats.
- Unsupported history-OT variants fail before mutation.
- Comment anchors are validated after edits.

---

## Milestone 6 — Accept and reject selected changes

### Objective

Safely finalize or discard selected tracked changes.

### Tasks

- [x] Add selection validation by change ID.
- [x] Refuse IDs not present in the current snapshot.
- [x] Refuse mixed-document selection.
- [x] Implement accept for legacy.
- [x] Implement reject for legacy.
- [x] Implement accept for history-OT.
- [x] Implement reject for history-OT.
- [x] Use captured Overleaf UI behavior as the contract.
- [x] Add dry-run result prediction.
- [x] Add expected-version precondition.
- [x] Verify requested IDs disappear.
- [x] Verify text outcome.
- [x] Verify unrelated IDs remain.
- [x] Add CLI commands.
- [x] Add library methods.
- [ ] Add tests for:
  - [x] accepting insertion;
  - [x] rejecting insertion;
  - [x] accepting deletion;
  - [x] rejecting deletion;
  - [x] multiple selected changes;
  - [ ] adjacent changes from different authors;
  - [x] stale IDs;
  - [x] concurrent edits.

### Deliverables

- accept/reject service
- CLI commands
- complete verification tests

### Exit criteria

- Selected changes are finalized correctly.
- Unselected changes remain unchanged.
- Text and range verification both pass.
- No bulk-all command is needed for release.

---

## Milestone 7 — Comment-to-change review workflow

### Objective

Connect comments, Git commits, and Overleaf tracked changes.

### Tasks

- [x] Add `.olcli-review.json` schema.
- [x] Implement atomic ledger reads/writes.
- [x] Add operation IDs.
- [x] Add comment lookup by thread ID.
- [x] Validate that the proposed edit overlaps or relates to the comment context when possible.
- [x] Create suggestion.
- [x] Record change IDs and source version.
- [x] Detect current Git commit.
- [x] Support commit trailers or a follow-up annotation command.
- [x] Reply to the thread with a concise summary.
- [x] Implement resolution policies:
  - [x] never;
  - [x] after-suggest;
  - [x] after-accept.
- [x] Make `never` the default.
- [x] Implement reconciliation:
  - [x] list ledger entries;
  - [x] determine whether change IDs remain;
  - [x] classify as accepted, rejected, or unknown;
  - [x] resolve only when policy allows.
- [x] Add `olcli review address`.
- [x] Add `olcli review status`.
- [x] Add `olcli review reconcile`.

### Deliverables

- review ledger
- review service
- address/status/reconcile commands

### Exit criteria

- One command can propose a change and reply without silently resolving.
- The ledger links thread, change IDs, source version, and Git commit.
- Reconciliation is idempotent.
- No document text or credentials are stored in the ledger.

---

## Milestone 8 — Read-only Overleaf history and diffs

### Objective

Expose useful native history information without treating it as the primary VCS.

### Tasks

- [x] Define normalized history entry types.
- [x] Implement history update listing.
- [x] Normalize timestamp and author metadata.
- [x] Implement file diff between versions.
- [x] Add pagination/min-count handling.
- [x] Add `olcli history list`.
- [x] Add `olcli history diff`.
- [x] Add library methods.
- [x] Add MCP read tools.
- [x] Document that history restoration is not supported.
- [ ] Optionally add `history snapshot-to-git` as a separate later issue.

### Deliverables

- history service
- read-only history CLI
- read-only history MCP tools

### Exit criteria

- Users can inspect versions and diffs.
- No command implies that Git and Overleaf version numbers are equivalent.
- No restoration endpoint is exposed.

---

## Milestone 9 — MCP review tools

### Objective

Expose stable, safe review workflows to AI clients.

### Tasks

- [x] Add capability and list tools.
- [x] Add suggestion preview tool.
- [x] Add suggestion mutation tool.
- [x] Add accept/reject tools.
- [x] Add review address/status/reconcile tools.
- [x] Enforce `OLCLI_MCP_REVIEW_MODE`.
- [x] Require structured preconditions for mutations.
- [x] Return stable error codes.
- [x] Avoid returning full document content unless requested.
- [x] Add MCP schema tests.
- [x] Add tool-level integration tests using a fake client.
- [x] Document least-privilege configuration.

### Deliverables

- MCP tools
- policy gate
- tool contract tests
- updated MCP docs

### Exit criteria

- Agent tools call the same service layer as CLI/library.
- Read mode cannot mutate.
- Suggest mode cannot accept/reject.
- All mutation results include verification state.

---

## Milestone 10 — Hardening, release, and upstream strategy

### Objective

Prepare a maintainable release rather than a one-off experiment.

### Tasks

- [x] Complete CI matrix.
- [x] Add package tests to the publish workflow.
- [x] Add protocol compatibility documentation.
- [x] Add security documentation.
- [x] Add migration notes.
- [x] Add `THIRD_PARTY_NOTICES.md`.
- [x] Decide package name if publishing outside upstream:
  - recommended `@xyin-anl/olcli`;
  - do not publish as `@aloth/olcli`.
- [x] Add experimental feature flag for the first release.
- [x] Add changelog entries.
- [x] Produce an npm pack dry run.
- [x] Defer Homebrew changes because this fork is not distributed that way.
- [ ] Open small upstream PRs where generally useful.
- [x] Keep fork-specific workflow orchestration separate from reusable protocol primitives.

### Exit criteria

- Release artifacts contain intended files only.
- Tests run before publish.
- Security and protocol limitations are prominent.
- Upstream sync instructions are current.
- The release can be installed without replacing the upstream package unintentionally.

---

## 17. Detailed protocol discovery playbook

Because the relevant APIs are internal, protocol discovery is part of engineering, not an informal side task.

### 17.1 Disposable project setup

Create a dedicated test project containing:

```text
main.tex
comments.tex
unicode.tex
nested/chapter.tex
```

Populate it with unique marker strings.

Never perform first experiments on a thesis, paper, or production project.

### 17.2 Capture cases

Capture sanitized requests/frames for:

- open project;
- join project;
- join each document format;
- turn track changes on for current user;
- turn it off;
- insert tracked text;
- delete tracked text;
- replace text;
- accept insertion;
- reject insertion;
- accept deletion;
- reject deletion;
- resolve/reopen comment;
- concurrent edit conflict;
- socket reconnect.

### 17.3 Sanitization requirements

Replace:

- project IDs;
- document IDs;
- user IDs;
- thread and change IDs;
- cookies;
- CSRF tokens;
- emails;
- real document text.

Preserve:

- field names;
- payload shape;
- event names;
- relative positions;
- version increments;
- operation ordering;
- acknowledgment/error shape.

### 17.4 Fixture metadata

Each fixture should include:

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-07-13",
  "instance": "overleaf-cloud",
  "operation": "tracked-replacement",
  "otType": "history-ot",
  "sanitized": true,
  "notes": "Target text was unique; browser was the only other client."
}
```

### 17.5 Protocol compatibility policy

Maintain:

```text
docs/PROTOCOL-COMPATIBILITY.md
```

Include:

- date last verified;
- Cloud or self-hosted version;
- OT type;
- supported actions;
- known failure modes;
- test project results.

---

## 18. Testing strategy

### 18.1 Unit tests

Cover pure logic:

- text matching;
- uniqueness and occurrence;
- line/column conversion;
- SHA-256 preconditions;
- minimal diff;
- track-change seed format;
- range normalization;
- change-ID set comparison;
- ledger transitions;
- error serialization;
- redaction.

Target high coverage for pure modules:

- 90%+ statements for matcher, operation builders, verification, and ledger;
- 80%+ for all new non-transport modules.

### 18.2 Transport tests

Use a fake transport to test:

- handshake;
- heartbeat;
- ack correlation;
- out-of-order ack;
- timeout;
- disconnect;
- duplicate event;
- malformed packet;
- error packet;
- cleanup after exception.

### 18.3 Contract tests

Replay sanitized fixtures:

- join response normalization;
- list changes;
- build suggestion payload;
- accept/reject payload;
- parse acknowledgment;
- version conflict;
- history-OT and legacy paths.

Contract tests must not require internet access.

### 18.4 Live E2E tests

Require explicit environment variables:

```text
OVERLEAF_SESSION
OLCLI_E2E_PROJECT_ID
OLCLI_E2E_ALLOW_MUTATION=1
OLCLI_E2E_OT_TYPE=history-ot
```

Optional separate project IDs:

```text
OLCLI_E2E_SHAREJS_PROJECT_ID
OLCLI_E2E_HISTORY_OT_PROJECT_ID
```

Rules:

- Skip mutation tests unless `OLCLI_E2E_ALLOW_MUTATION=1`.
- Use unique markers.
- Back up original test files.
- Clean up best-effort.
- Print IDs only in redacted form.
- Never run live E2E on pull requests from untrusted forks with secrets.
- Rate-limit calls.
- Fail clearly when the track-changes feature is unavailable.

### 18.5 Required live scenarios

| Scenario | Expected result |
|---|---|
| Unique replacement | Native suggestion with verified IDs |
| Ambiguous old text | No mutation |
| Stale expected version | Conflict, no mutation |
| Browser edits after read | Conflict or source mismatch |
| Insert before comment | Comment moves correctly |
| Insert inside comment | Comment context updates or detectable incompatibility |
| Delete entire comment anchor | Defined, tested behavior |
| Unicode before edit | Correct offsets |
| Accept insertion | Text remains, marker removed |
| Reject insertion | Text removed, marker removed |
| Accept deletion | Deleted text remains absent, marker removed |
| Reject deletion | Deleted text restored, marker removed |
| Track state initially on | Remains on |
| Track state initially off | Returns to off |
| Track state object | Exact mapping restored |
| Session expires | Stable auth error |
| Browser open concurrently | No silent overwrite |

---

## 19. Continuous integration

Add `.github/workflows/ci.yml`.

Recommended matrix:

```text
Node 18
Node 20
Node 22
Node 24
```

Required jobs:

1. Install with `npm ci`.
2. Typecheck.
3. Lint.
4. Unit and contract tests.
5. Build.
6. `npm pack --dry-run`.
7. Verify package entry points.

Live E2E:

- separate workflow;
- `workflow_dispatch` or protected scheduled run;
- environment approval;
- no execution on untrusted pull requests.

Publish workflow:

- must run `npm test`, not only `npm test --if-present`;
- must require CI success for the release commit/tag.

---

## 20. Security plan

### 20.1 Treat the session cookie as a password

- Never log it.
- Never include it in fixture files.
- Never place it in GitHub issue text.
- Prefer environment variables or protected config.
- Ensure stored credential files use restrictive permissions.
- Warn that `--cookie` can appear in shell history and process listings.

### 20.2 CSRF and headers

Redact:

```text
Cookie
Set-Cookie
X-Csrf-Token
Authorization
```

### 20.3 Document confidentiality

Default verbose logging must not print:

- full source;
- comment bodies;
- compile logs containing source excerpts;
- thread messages.

Offer an explicit unsafe diagnostic mode only for disposable projects.

### 20.4 MCP permissions

- Default new tools to read or suggest mode.
- Keep accept/reject behind full mode.
- Do not let a model infer `--all`.
- Require explicit IDs and preconditions.
- Return partial-failure details.

### 20.5 Destructive operations

Before accept/reject:

- snapshot source hash;
- snapshot tracked-change IDs;
- record document version;
- optionally write a local backup;
- verify after mutation.

---

## 21. Licensing and provenance

This is important because three codebases are involved.

### 21.1 `aloth/olcli`

The upstream project is MIT-licensed. Preserve attribution and license notices.

### 21.2 `dylantmoore/overleaf-cli`

Use it as a behavioral and architectural reference. Its README states MIT, but verify the exact license and commit before copying code. At the time of this planning audit, a root `LICENSE` file was not found through the repository connector.

Preferred approach:

- reimplement concepts;
- document inspiration;
- copy only after license verification;
- preserve required attribution.

### 21.3 Official `overleaf/overleaf`

The official repository is AGPLv3.

Use it to understand:

- names and concepts;
- expected behavior;
- public wire shapes visible in the client;
- test scenarios.

Do not paste substantial AGPL implementation code into an MIT project without understanding the licensing consequences. Build an independent implementation from observed behavior, protocol captures, and your own tests. Add a legal review checkpoint before importing any official code or package.

### 21.4 Provenance record

Add:

```text
docs/PROTOCOL-NOTES.md
THIRD_PARTY_NOTICES.md
```

For every borrowed implementation, record:

- source repository;
- commit;
- file;
- license;
- what was copied or adapted;
- attribution.

This section is an engineering risk control, not legal advice.

---

## 22. Observability and supportability

Every mutation result should include:

```json
{
  "operationId": "uuid",
  "projectId": "redacted-or-full-by-output-mode",
  "docId": "…",
  "path": "main.tex",
  "otType": "history-ot",
  "beforeVersion": 104,
  "afterVersion": 105,
  "verified": true,
  "trackChangesStateRestored": true
}
```

Recommended diagnostic command:

```bash
olcli changes doctor "My Paper" --file main.tex --json
```

Do not include source text by default. Include source context only when the user requests it.

Add a compatibility warning when:

- OT type is unknown;
- project feature flags are absent;
- the server response shape differs from fixtures;
- track state cannot be restored;
- mutation was acknowledged but verification failed.

---

## 23. Concurrency and idempotency model

### 23.1 Optimistic concurrency

Before mutation:

1. Join document.
2. Read version and text.
3. Validate expected version/hash/text.
4. Build operation.
5. Submit exactly once.
6. Wait for acknowledgment.
7. Re-read and verify.

### 23.2 No automatic mutation retry

A timeout creates uncertainty: the server may have applied the operation even if the acknowledgment was lost.

On timeout:

1. Re-read document and change ranges.
2. Check whether the expected result/change IDs exist.
3. Classify:
   - applied and verified;
   - not applied;
   - ambiguous.
4. Do not blindly resend.

### 23.3 Operation IDs

Generate a local UUID for every mutation. Store it in the local ledger and logs. The protocol may not support a first-class idempotency key, but the operation ID helps reconcile ambiguous outcomes.

### 23.4 Conflict output

Return enough information to retry manually:

- current version;
- expected version;
- current source hash;
- whether old text is still found;
- nearby context when explicitly requested.

---

## 24. Review workflow policy

### 24.1 Safe default

After creating a suggestion:

- reply to the thread;
- leave the thread open.

Suggested reply:

```text
Proposed a tracked revision in main.tex. Change IDs: <ids>. Git commit: <sha>.
```

### 24.2 After-accept resolution

`review reconcile` should:

1. Load ledger.
2. List current changes.
3. If listed IDs disappeared, inspect text and history evidence.
4. Classify accepted or rejected.
5. Resolve only if accepted and policy is `after-accept`.
6. Leave a final reply if configured.

Do not infer acceptance solely because an ID disappeared; it may have been superseded or deleted. Verify text.

---

## 25. Documentation set

Create or update:

```text
README.md
workplan.md
docs/UPSTREAM.md
docs/TRACKED-CHANGES.md
docs/PROTOCOL-COMPATIBILITY.md
docs/PROTOCOL-NOTES.md
docs/MCP.md
docs/SECURITY.md
docs/REVIEW-WORKFLOW.md
THIRD_PARTY_NOTICES.md
CHANGELOG.md
```

`docs/TRACKED-CHANGES.md` must include:

- feature entitlement requirements;
- internal API disclaimer;
- disposable-project recommendation;
- command examples;
- conflict behavior;
- supported OT types;
- accept/reject semantics;
- recovery after partial failure.

---

## 26. Release plan

### 26.1 Experimental release

Gate mutations with one of:

```text
OLCLI_EXPERIMENTAL_TRACKED_CHANGES=1
```

or:

```bash
olcli changes suggest ... --experimental
```

Prefer the environment flag for MCP and the CLI flag for direct use during early testing.

### 26.2 Package naming

If publishing independently:

- use `@xyin-anl/olcli`;
- preserve the `olcli` binary only if package conflict is understood;
- clearly state that it is an experimental fork;
- do not publish to the upstream package scope.

### 26.3 Versioning

Suggested sequence:

```text
0.8.0-alpha.1  read-only changes listing
0.8.0-alpha.2  targeted suggestions for first OT format
0.8.0-beta.1   dual-format suggestions
0.8.0-beta.2   accept/reject
0.8.0-rc.1     review workflow and MCP
0.8.0          hardened release
```

### 26.4 Release gates

- [ ] CI green on all supported Node versions.
- [x] Live E2E green on disposable project.
- [x] No secrets in logs or package.
- [x] `npm pack --dry-run` reviewed.
- [x] Protocol compatibility page updated.
- [x] Changelog updated.
- [x] Known limitations documented.
- [x] Recovery procedure tested.

---

# 27. Issue backlog

Create these as GitHub issues. Keep each issue independently reviewable.

| ID | Issue title | Milestone | Dependencies |
|---|---|---:|---|
| INFRA-001 | Record upstream baseline and add sync documentation | 0 | none |
| INFRA-002 | Add CI build/typecheck matrix | 0 | none |
| TEST-001 | Add Vitest and real `npm test` script | 1 | INFRA-002 |
| TEST-002 | Add sanitized protocol fixture format | 1 | TEST-001 |
| TEST-003 | Characterize existing comment range behavior | 1 | TEST-001 |
| SEC-001 | Add centralized secret redaction | 1 | none |
| SEC-002 | Audit verbose output for document leakage | 1 | SEC-001 |
| RT-001 | Define real-time protocol and snapshot types | 2 | TEST-001 |
| RT-002 | Extract Socket.IO v0.9 transport | 2 | RT-001 |
| RT-003 | Implement project session and file lookup | 2 | RT-002 |
| RT-004 | Implement document join/leave/refresh | 2 | RT-003 |
| RT-005 | Implement acknowledged submit with version errors | 2 | RT-004 |
| RT-006 | Refactor comments to use document session | 2 | RT-005, TEST-003 |
| CHG-001 | Implement track-changes capability report | 3 | RT-004 |
| CHG-002 | Define normalized tracked-change model | 3 | RT-001 |
| CHG-003 | Parse legacy ShareJS tracked ranges | 3 | CHG-002 |
| CHG-004 | Parse history-OT tracked ranges | 3 | CHG-002 |
| CLI-001 | Add `changes doctor` | 3 | CHG-001 |
| CLI-002 | Add `changes list` | 3 | CHG-003, CHG-004 |
| CHG-005 | Implement unique text matcher and occurrence selection | 4 | TEST-001 |
| CHG-006 | Implement mutation preconditions and source hashing | 4 | CHG-005 |
| CHG-007 | Implement exact track-changes state save/restore | 4 | CHG-001 |
| CHG-008 | Implement track-change ID seed generation | 4 | TEST-002 |
| CHG-009 | Implement first-format tracked replacement | 4 | RT-005, CHG-006, CHG-007 |
| CHG-010 | Implement post-mutation verification | 4 | CHG-009 |
| CLI-003 | Add `changes suggest` and dry-run | 4 | CHG-010 |
| CHG-011 | Implement second-format tracked replacement | 5 | CHG-009 |
| TEST-004 | Add dual-format mutation contract fixtures | 5 | CHG-011 |
| CHG-012 | Implement accept for legacy | 6 | CHG-003, RT-005 |
| CHG-013 | Implement reject for legacy | 6 | CHG-003, RT-005 |
| CHG-014 | Implement accept for history-OT | 6 | CHG-004, RT-005 |
| CHG-015 | Implement reject for history-OT | 6 | CHG-004, RT-005 |
| CLI-004 | Add `changes accept` and `changes reject` | 6 | CHG-012–015 |
| REVIEW-001 | Add versioned review ledger | 7 | TEST-001 |
| REVIEW-002 | Link suggestion results to comments | 7 | REVIEW-001, CLI-003 |
| REVIEW-003 | Add resolution policies | 7 | REVIEW-002 |
| REVIEW-004 | Add review reconciliation | 7 | REVIEW-003, CLI-004 |
| HIST-001 | Normalize history updates | 8 | RT-001 |
| HIST-002 | Add document version diff | 8 | HIST-001 |
| CLI-005 | Add history command group | 8 | HIST-001, HIST-002 |
| MCP-001 | Add read-only tracked-change tools | 9 | CLI-002 |
| MCP-002 | Add review-mode policy gate | 9 | MCP-001 |
| MCP-003 | Add suggestion tool | 9 | MCP-002, CLI-003 |
| MCP-004 | Add accept/reject tools | 9 | MCP-002, CLI-004 |
| DOC-001 | Add tracked-change user guide | 10 | CLI-004 |
| DOC-002 | Add protocol compatibility matrix | 10 | TEST-004 |
| LIC-001 | Add provenance and third-party notices | 10 | none |
| REL-001 | Prepare experimental package release | 10 | all P0/P1 issues |
| UPSTREAM-001 | Propose reusable real-time extraction upstream | 10 | RT-006 |
| UPSTREAM-002 | Propose read-only changes listing upstream | 10 | CLI-002 |

---

## 28. Recommended first commits

Keep these commits small and reviewable:

1. `docs: add tracked-changes work plan and upstream sync notes`
2. `test: add vitest, typecheck, and baseline unit test`
3. `security: add centralized request and secret redaction`
4. `refactor: define realtime protocol and document snapshot types`
5. `refactor: extract socket.io v0.9 transport`
6. `refactor: add project and document sessions`
7. `refactor: migrate comments to realtime document sessions`
8. `feat: add tracked-changes capability doctor`
9. `feat: add read-only tracked-changes listing`
10. `feat: add targeted suggestion preview`
11. `feat: submit and verify tracked suggestions`
12. `feat: add second OT adapter`
13. `feat: accept and reject selected changes`
14. `feat: add review ledger and comment workflow`
15. `feat: expose review tools through MCP`
16. `docs: publish protocol compatibility and security guidance`

Do not combine transport extraction, tracked mutation, and MCP exposure in one pull request.

---

## 29. Pull-request checklist

Every protocol PR should answer these review-template questions (they are not
implementation-status checkboxes):

- Which OT type is affected?
- What raw behavior was observed?
- Are fixtures sanitized?
- Is the change read-only or mutating?
- What preconditions prevent stale writes?
- What acknowledgment confirms submission?
- What postcondition verifies success?
- What happens after timeout?
- Is track-changes state restored?
- Are comments preserved?
- Does verbose output redact secrets and text?
- Are both CLI JSON and library types updated?
- Are MCP tools intentionally included or deferred?
- Is the implementation independently written?
- Are license/provenance notes updated?
- Are live E2E results recorded?

---

## 30. Recovery procedures

### 30.1 State restoration failure

If the tracked edit succeeds but state restoration fails:

- return `PARTIAL_FAILURE`;
- include `verified: true`;
- include `trackChangesStateRestored: false`;
- report the exact prior state needed for manual restoration;
- do not hide the successful edit.

### 30.2 Acknowledgment timeout

- reconnect;
- re-read text and ranges;
- compare expected result;
- report `applied`, `not-applied`, or `ambiguous`;
- never resend automatically while ambiguous.

### 30.3 Verification failure

- save a local diagnostic record without secrets or full text;
- include versions and change-ID sets;
- advise checking the Overleaf UI;
- do not continue to reply/resolve comments automatically.

### 30.4 Ledger corruption

- rename corrupt file with a timestamp;
- create no new ledger until the user explicitly proceeds;
- never silently discard old entries.

### 30.5 Protocol drift

- fail closed on unknown response shape;
- update compatibility docs;
- add a sanitized fixture reproducing the new shape;
- update adapter and tests before re-enabling mutation.

---

## 31. MVP demonstration script

This is the acceptance demonstration for the first tracked-suggestion release:

```bash
# 1. Verify account/project/document support
olcli changes doctor "$PROJECT_ID" --file main.tex --json

# 2. Inspect current comments and tracked changes
olcli comments list "$PROJECT_ID" --status open --context 2 --json
olcli changes list "$PROJECT_ID" --file main.tex --context 2 --json

# 3. Preview a suggestion
olcli changes suggest main.tex \
  --old "A uniquely identifiable original sentence." \
  --new "A uniquely identifiable revised sentence." \
  "$PROJECT_ID" \
  --dry-run \
  --json

# 4. Submit it
olcli changes suggest main.tex \
  --old "A uniquely identifiable original sentence." \
  --new "A uniquely identifiable revised sentence." \
  "$PROJECT_ID" \
  --json

# 5. Re-list and verify the returned IDs
olcli changes list "$PROJECT_ID" --file main.tex --json

# 6. Compile
olcli compile "$PROJECT_ID"

# 7. Accept or reject one explicit ID
olcli changes accept main.tex "$CHANGE_ID" --project "$PROJECT_ID" --json
# or:
olcli changes reject main.tex "$CHANGE_ID" --project "$PROJECT_ID" --json
```

The demonstration passes only if the Overleaf UI agrees with every reported state.

---

## 32. Complete release definition of done

### Functionality

- [x] Comments remain functional.
- [x] Pull/push/sync remain functional.
- [x] Compile/PDF remain functional.
- [x] Tracked changes can be listed.
- [x] Targeted suggestions work.
- [x] Accept/reject work by explicit ID.
- [x] Both OT formats are either supported or fail clearly.
- [x] History list/diff work read-only.
- [x] CLI/library/MCP share one implementation.

### Safety

- [x] Source/version preconditions exist.
- [x] No mutation auto-retry.
- [x] Post-mutation verification exists.
- [x] Track state is restored.
- [x] Secrets are redacted.
- [x] MCP permissions are gated.
- [x] Default comment resolution is `never`.

### Quality

- [x] Unit tests pass.
- [x] Contract tests pass.
- [x] Live E2E passes.
- [x] Build and typecheck pass.
- [x] Package dry run is reviewed.
- [x] Protocol compatibility is documented.
- [x] Recovery procedures are documented.

### Maintainability

- [x] Real-time transport is separated from domain logic.
- [x] OT formats are separated behind adapters.
- [x] Error codes are stable.
- [x] Ledger schema is versioned.
- [x] Upstream sync process is documented.
- [x] License provenance is recorded.

---

## 33. Remaining follow-ups after the 2026-07-15 audit

The local release candidate is usable for the live-tested
`sharejs-text-ot` agent-review workflow. The remaining work is:

1. Obtain a disposable live project that reports `history-ot`, then mutation-
   test suggest, accept, reject, state restoration, and recovery on it.
2. Run a controlled live browser race and confirm stale document versions fail
   without overwriting collaborator edits.
3. Test comment anchors before, inside, and after edits, including adjacent and
   overlapping tracked changes from different authors.
4. Run the complete legacy pull/push/sync/PDF/Git-remote E2E suite on a second
   disposable fixture with no review data to preserve.
5. Let GitHub CI run the Node 18/20/22/24 matrix, then configure required checks
   and branch protection if desired.
6. Create backlog issues and upstream small reusable fixes when repository
   coordination is desired.
7. Consider `history snapshot-to-git` only as a separate optional feature.

The critical principle is:

> **Read and verify the protocol before mutating it; verify every mutation before continuing the workflow.**
