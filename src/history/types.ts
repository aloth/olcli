export interface HistoryAuthor {
  id?: string;
  name: string;
}

export interface HistoryLabel {
  id: string;
  comment: string;
  version: number;
  createdAt?: string;
  authorId?: string;
  authorName?: string;
}

export type HistoryProjectOperationKind = 'add' | 'remove' | 'rename';

export interface HistoryProjectOperation {
  kind: HistoryProjectOperationKind;
  atVersion: number;
  path: string;
  newPath?: string;
}

export interface HistoryOrigin {
  kind: string;
  path?: string;
  timestamp?: string;
  version?: number;
}

/**
 * One Overleaf project-history update group.
 *
 * These versions are not Git commits and are not document OT versions.
 */
export interface HistoryEntry {
  id: string;
  fromVersion: number;
  toVersion: number;
  startedAt: string;
  endedAt: string;
  authors: HistoryAuthor[];
  pathnames: string[];
  projectOperations: HistoryProjectOperation[];
  labels: HistoryLabel[];
  origin?: HistoryOrigin;
  external: boolean;
}

export interface ListHistoryOptions {
  /** Maximum normalized entries returned to the caller (1–200). */
  limit?: number;
  /** Return entries strictly older than this project-history version. */
  before?: number;
  /** Minimum batch requested from Overleaf (1–100); not a server-side cap. */
  minCount?: number;
}

export interface HistoryListResult {
  projectId: string;
  entries: HistoryEntry[];
  nextBefore?: number;
  atEnd: boolean;
}

export type HistoryFileOperation =
  | 'unchanged'
  | 'added'
  | 'removed'
  | 'edited'
  | 'renamed';

export interface HistoryFileChange {
  path: string;
  operation: HistoryFileOperation;
  editable?: boolean;
  oldPath?: string;
  newPath?: string;
  deletedAtVersion?: number;
}

export type HistoryDiffChunkKind = 'unchanged' | 'insert' | 'delete';

export interface HistoryDiffChunk {
  kind: HistoryDiffChunkKind;
  offset: number;
  length: number;
  text?: string;
  authors: HistoryAuthor[];
  startedAt?: string;
  endedAt?: string;
}

export interface HistoryDiffStats {
  insertedCharacters: number;
  deletedCharacters: number;
  unchangedCharacters: number;
}

export interface DiffHistoryOptions {
  /** Include chunk text. Defaults to true for the library and CLI. */
  includeContent?: boolean;
  /** Include unchanged chunks. Defaults to false. */
  includeUnchanged?: boolean;
}

export interface HistoryFileDiffResult {
  projectId: string;
  path: string;
  fromVersion: number;
  toVersion: number;
  file: HistoryFileChange;
  binary: boolean;
  chunks: HistoryDiffChunk[];
  stats: HistoryDiffStats;
}

export interface HistoryServiceHost {
  getHistoryJson(path: string): Promise<unknown>;
}
