import type { CommentContext } from '../client.js';
import type { JoinedDocument, OverleafOtType } from '../realtime/types.js';

export type TrackedChangeKind = 'insert' | 'delete';

export type OverleafPermissionsLevel =
  | 'owner'
  | 'readAndWrite'
  | 'review'
  | 'readOnly'
  | `unknown:${string}`;

export type TrackChangesState = boolean | Record<string, boolean>;

export interface TrackedChange {
  id: string;
  docId: string;
  path: string;
  otType: OverleafOtType;
  kind: TrackedChangeKind;
  /** Position in the visible editor document (tracked deletions excluded). */
  position: number;
  /** Position in the history-OT snapshot, when it differs from the editor. */
  snapshotPosition?: number;
  line: number;
  column: number;
  text: string;
  authorId?: string;
  timestamp?: string;
  context?: CommentContext;
  /** Undocumented wire data, returned only when explicitly requested. */
  raw?: unknown;
}

/** Text-free snapshot metadata used by durable review reconciliation. */
export interface TrackedDocumentInspection {
  projectId: string;
  docId: string;
  path: string;
  otType: OverleafOtType;
  version: number;
  textSha256: string;
}

export interface ListTrackedChangesOptions {
  filePath?: string;
  contextLines?: number;
  includeRaw?: boolean;
}

export interface MutationPrecondition {
  expectedVersion?: number;
  expectedTextSha256?: string;
}

export interface NormalizedTextOperation {
  kind: TrackedChangeKind;
  position: number;
  text: string;
}

export interface AdapterMutation {
  operations: unknown[];
  normalizedOperations: NormalizedTextOperation[];
  metadata: Record<string, unknown>;
}

export interface BuildTrackedReplacementOptions {
  trackChangeSeed: string;
  currentUserId: string;
  timestamp: Date;
}

export type ChangeResolutionAction = 'accept' | 'reject';

export interface AdapterResolution {
  transport: 'ot' | 'legacy-accept-endpoint';
  operations: unknown[];
}

export interface SuggestChangeInput {
  projectId: string;
  filePath: string;
  oldText: string;
  newText: string;
  occurrence?: number;
  position?: number;
  line?: number;
  column?: number;
  precondition?: MutationPrecondition;
  dryRun?: boolean;
}

export interface SuggestionPreview {
  projectId: string;
  docId: string;
  path: string;
  otType: OverleafOtType;
  version: number;
  textSha256: string;
  position: number;
  line: number;
  column: number;
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

export interface ResolveChangesInput {
  projectId: string;
  filePath: string;
  changeIds: string[];
  action: ChangeResolutionAction;
  precondition?: MutationPrecondition;
  dryRun?: boolean;
}

export interface ChangeResolutionPreview {
  projectId: string;
  docId: string;
  path: string;
  otType: OverleafOtType;
  action: ChangeResolutionAction;
  version: number;
  textSha256: string;
  changeIds: string[];
  changes: Array<Pick<TrackedChange, 'id' | 'kind' | 'position' | 'text'>>;
  expectedResultSha256: string;
  transport: AdapterResolution['transport'];
}

export interface ChangeResolutionResult extends ChangeResolutionPreview {
  beforeVersion: number;
  afterVersion: number;
  verified: boolean;
  remainingChangeIds: string[];
}

export interface ChangesCapabilities {
  projectId: string;
  docId: string;
  path: string;
  permissionsLevel: OverleafPermissionsLevel;
  canWrite: boolean;
  canTrackedWrite: boolean;
  featureAvailable: boolean;
  trackChangesStateReadable: boolean;
  trackChangesState?: TrackChangesState;
  trackChangesEnabledForCurrentUser?: boolean;
  currentUserId?: string;
  otType: OverleafOtType;
  canList: boolean;
  canSuggest: boolean;
  canAccept: boolean;
  canReject: boolean;
  reasons: string[];
}

export interface TrackedChangesAdapterOptions {
  contextLines?: number;
  includeRaw?: boolean;
}

export interface TrackedChangesAdapter {
  readonly otType: OverleafOtType;
  listChanges(
    document: JoinedDocument,
    path: string,
    options?: TrackedChangesAdapterOptions
  ): TrackedChange[];
  buildTrackedReplacement(
    document: JoinedDocument,
    position: number,
    oldText: string,
    newText: string,
    options: BuildTrackedReplacementOptions
  ): AdapterMutation;
  getEditorContent(document: JoinedDocument): string;
  buildTrackedResolution(
    document: JoinedDocument,
    changes: TrackedChange[],
    action: ChangeResolutionAction
  ): AdapterResolution;
}
