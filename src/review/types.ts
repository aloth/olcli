import type { ProjectComment } from '../client.js';
import type {
  MutationPrecondition,
  SuggestionPreview,
  SuggestionResult,
  TrackedDocumentInspection,
} from '../changes/types.js';

export type ReviewResolutionPolicy = 'never' | 'after-suggest' | 'after-accept';

export type ReviewEntryState =
  | 'prepared'
  | 'suggested'
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'superseded';

export type ReviewReplyStatus = 'pending' | 'posted' | 'failed';

/**
 * Durable metadata for one comment-to-suggestion operation.
 *
 * Source text, reply bodies, credentials, and reviewer identity are
 * intentionally absent. Hashes are sufficient for reconciliation.
 */
export interface ReviewLedgerEntry {
  operationId: string;
  threadId: string;
  docId: string;
  path: string;
  sourceVersion: number;
  sourceSha256: string;
  expectedResultSha256: string;
  requestSha256: string;
  changeIds: string[];
  gitCommit?: string;
  createdAt: string;
  updatedAt: string;
  state: ReviewEntryState;
  resolutionPolicy: ReviewResolutionPolicy;
  replySha256: string;
  replyStatus: ReviewReplyStatus;
  commentResolvedAt?: string;
  lastErrorCode?: string;
}

export interface ReviewLedger {
  schemaVersion: 1;
  projectId: string;
  entries: ReviewLedgerEntry[];
}

export interface ReviewStorageOptions {
  /** Absolute or working-directory-relative ledger path. */
  ledgerPath?: string;
  /** Used for the default ledger location and Git commit detection. */
  workingDirectory?: string;
}

export interface AddressReviewCommentInput extends ReviewStorageOptions {
  projectId: string;
  threadId: string;
  filePath: string;
  oldText: string;
  newText: string;
  occurrence?: number;
  position?: number;
  line?: number;
  column?: number;
  precondition?: MutationPrecondition;
  reply?: string;
  resolutionPolicy?: ReviewResolutionPolicy;
  operationId?: string;
  /** Explicit escape hatch for edits outside the comment's selected range. */
  allowUnrelated?: boolean;
  dryRun?: boolean;
}

export interface AddressReviewPreview {
  operationId: string;
  threadId: string;
  path: string;
  relatedToComment: boolean;
  resolutionPolicy: ReviewResolutionPolicy;
  gitCommit?: string;
  suggestion: SuggestionPreview;
}

export interface AddressReviewResult {
  operationId: string;
  resumed: boolean;
  entry: ReviewLedgerEntry;
  suggestion?: SuggestionResult;
}

export interface ReviewStatusInput extends ReviewStorageOptions {
  projectId: string;
}

export interface ReconcileReviewInput extends ReviewStorageOptions {
  projectId: string;
  operationIds?: string[];
  dryRun?: boolean;
}

export interface ReconcileReviewItem {
  operationId: string;
  previousState: ReviewEntryState;
  state: ReviewEntryState;
  activeChangeIds: string[];
  document: TrackedDocumentInspection;
  commentResolved: boolean;
  commentResolutionPlanned: boolean;
}

export interface ReconcileReviewResult {
  projectId: string;
  dryRun: boolean;
  items: ReconcileReviewItem[];
}

export interface AnnotateReviewCommitInput extends ReviewStorageOptions {
  projectId: string;
  operationId: string;
  commit?: string;
}

export interface ReviewServiceHost {
  getComment(projectId: string, threadId: string): Promise<ProjectComment>;
  previewTrackedSuggestion(input: {
    projectId: string;
    filePath: string;
    oldText: string;
    newText: string;
    occurrence?: number;
    position?: number;
    line?: number;
    column?: number;
    precondition?: MutationPrecondition;
  }): Promise<SuggestionPreview>;
  suggestTrackedChange(input: {
    projectId: string;
    filePath: string;
    oldText: string;
    newText: string;
    occurrence?: number;
    position?: number;
    line?: number;
    column?: number;
    precondition?: MutationPrecondition;
  }): Promise<SuggestionPreview | SuggestionResult>;
  listTrackedChanges(
    projectId: string,
    options: { filePath: string }
  ): Promise<Array<{ id: string }>>;
  inspectTrackedDocument(
    projectId: string,
    filePath: string
  ): Promise<TrackedDocumentInspection>;
  postCommentMessage(projectId: string, threadId: string, content: string): Promise<unknown>;
  resolveComment(projectId: string, threadId: string): Promise<ProjectComment>;
}
