/**
 * @aloth/olcli — Programmatic API
 *
 * Re-exports the public surface of OverleafClient and all associated
 * interfaces/types so consumers can import directly from the package root.
 *
 * @example
 * ```ts
 * import { OverleafClient } from '@aloth/olcli';
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
  type ProjectTemplate,
  type CreateProjectOptions,
  type CreatedProject,
  type FolderEntry,
  type DocEntry,
  type FileEntry,
  type CommentMessage,
  type ProjectComment,
  type CommentContext,
  type ListCommentsOptions,
  resolveCommentConcurrency,
  DEFAULT_COMMENT_CONCURRENCY,
  MAX_COMMENT_CONCURRENCY,
  type AddCommentOptions,
  type TrackedChange,
  type ListTrackedChangesOptions,
  type ProjectReview,
  type RejectionPlan,
  type RejectionDocPlan,
  type AcceptancePlan,
  type AcceptanceDocPlan,
  RejectConflictError,
  type Credentials,
  type SessionCookiePair,
  // Type aliases
  type CommentStatus,
} from './client.js';

// Tracked changes: kinds, authors and the ShareJS op format
export {
  type TrackedChangeKind,
  type TrackedChangeAuthor,
  type ShareJsTextOp
} from './tracked-changes.js';

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
