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
  type FolderEntry,
  type DocEntry,
  type FileEntry,
  type CommentMessage,
  type ProjectComment,
  type CommentContext,
  type ListCommentsOptions,
  type AddCommentOptions,
  type Credentials,
  // Type aliases
  type CommentStatus,
} from './client.js';

// Configuration utilities
export {
  getBaseUrl,
  setBaseUrl,
  getSessionCookieName,
  setSessionCookieName,
  getSessionCookie,
  setSessionCookie,
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
