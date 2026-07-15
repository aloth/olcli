/**
 * @xyin-anl/olcli — Programmatic API
 *
 * Re-exports the public surface of OverleafClient and all associated
 * interfaces/types so consumers can import directly from the package root.
 *
 * @example
 * ```ts
 * import { OverleafClient } from '@xyin-anl/olcli';
 *
 * const client = await OverleafClient.fromSessionCookie(cookie);
 * const projects = await client.listProjects();
 * ```
 */

// Core client class + all public interfaces/types
export {
  OverleafClient,
  // Interfaces
  type Project,
  type ProjectInfo,
  type FolderEntry,
  type DocEntry,
  type FileEntry,
  type CommentMessage,
  type ProjectComment,
  type CommentContext,
  type ListCommentsOptions,
  type AddCommentOptions,
  type Credentials,
  type SessionCookiePair,
  // Type aliases
  type CommentStatus,
} from './client.js';

export { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';
export {
  isExperimentalReviewEnabled,
  requireExperimentalReview,
} from './experimental.js';

// Configuration utilities
export {
  getBaseUrl,
  setBaseUrl,
  getSessionCookieName,
  setSessionCookieName,
  getSessionCookie,
  setSessionCookie,
  getTimeout,
  setTimeout,
  getPasswordCredentials,
  setPasswordCredentials,
  clearPasswordCredentials,
  type PasswordCredentials,
  getCsrf,
  setCsrf,
  getLastProject,
  setLastProject,
  clearConfig,
  getConfigPath,
  saveOlAuth,
} from './config.js';

// Ignore subsystem
export {
  DEFAULT_IGNORE_PATTERNS,
  loadIgnore,
  shouldIgnore,
  buildTexSiblingSet,
  type IgnoreContext,
  type LoadIgnoreOptions,
} from './ignore.js';

// Stable errors used by CLI, library, and future MCP review operations
export { OlcliError } from './errors/olcli-error.js';
export { serializeError, type SerializedOlcliError } from './errors/serialize-error.js';
export type { OlcliErrorCode } from './errors/codes.js';

// Real-time protocol domain types (transport implementation remains internal)
export type { JoinedDocument, OverleafOtType } from './realtime/types.js';
export { ProjectSession, type RealtimeDocumentRef } from './realtime/project-session.js';
export {
  DocumentSession,
  type DocumentSubmitInput,
  type DocumentSubmitResult,
} from './realtime/document-session.js';

// Native tracked-change inspection (read-only in the first milestone)
export type {
  ChangesCapabilities,
  AdapterMutation,
  AdapterResolution,
  BuildTrackedReplacementOptions,
  ChangeResolutionAction,
  ChangeResolutionPreview,
  ChangeResolutionResult,
  ListTrackedChangesOptions,
  MutationPrecondition,
  NormalizedTextOperation,
  OverleafPermissionsLevel,
  SuggestChangeInput,
  SuggestionPreview,
  SuggestionResult,
  ResolveChangesInput,
  TrackChangesState,
  TrackedChange,
  TrackedChangeKind,
  TrackedDocumentInspection,
  TrackedChangesAdapter,
  TrackedChangesAdapterOptions,
} from './changes/types.js';
export { getTrackedChangesAdapter } from './changes/adapters.js';
export { ChangesService, type ChangesServiceHost } from './changes/service.js';
export {
  lineColumnToPosition,
  resolveTextMatchPosition,
  sha256Text,
  type TextMatchInput,
} from './changes/matcher.js';
export { generateTrackChangeSeed } from './changes/track-change-seed.js';

// Durable comment-to-change review workflow
export {
  ReviewLedgerStore,
  REVIEW_LEDGER_FILENAME,
  validateReviewLedger,
} from './review/ledger.js';
export {
  ReviewService,
  type ReviewServiceOptions,
} from './review/service.js';
export {
  resolveGitCommit,
  requireGitCommit,
  reviewCommitTrailers,
} from './review/git-metadata.js';
export type {
  AddressReviewCommentInput,
  AddressReviewPreview,
  AddressReviewResult,
  AnnotateReviewCommitInput,
  ReconcileReviewInput,
  ReconcileReviewItem,
  ReconcileReviewResult,
  ReviewEntryState,
  ReviewLedger,
  ReviewLedgerEntry,
  ReviewReplyStatus,
  ReviewResolutionPolicy,
  ReviewServiceHost,
  ReviewStatusInput,
  ReviewStorageOptions,
} from './review/types.js';

// Read-only Overleaf project-history inspection
export {
  HistoryService,
  normalizeHistoryAuthors,
  normalizeHistoryDocDiffResponse,
  normalizeHistoryEntry,
  normalizeHistoryFileTreeResponse,
} from './history/service.js';
export type {
  DiffHistoryOptions,
  HistoryAuthor,
  HistoryDiffChunk,
  HistoryDiffChunkKind,
  HistoryDiffStats,
  HistoryEntry,
  HistoryFileChange,
  HistoryFileDiffResult,
  HistoryFileOperation,
  HistoryLabel,
  HistoryListResult,
  HistoryOrigin,
  HistoryProjectOperation,
  HistoryProjectOperationKind,
  HistoryServiceHost,
  ListHistoryOptions,
} from './history/types.js';
