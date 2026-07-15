import { OlcliError } from '../errors/olcli-error.js';
import type { ProjectSession } from '../realtime/project-session.js';
import type { JoinedDocument } from '../realtime/types.js';
import { positionToLineColumn } from '../comments/range-parser.js';
import { getTrackedChangesAdapter } from './adapters.js';
import {
  detectChangesCapabilities,
  readTrackChangesProjectState,
} from './capabilities.js';
import {
  resolveTextMatchPosition,
  sha256Text,
} from './matcher.js';
import { generateTrackChangeSeed } from './track-change-seed.js';
import type {
  AdapterMutation,
  AdapterResolution,
  ChangeResolutionPreview,
  ChangeResolutionResult,
  ResolveChangesInput,
  SuggestChangeInput,
  SuggestionPreview,
  SuggestionResult,
  TrackChangesState,
  TrackedChange,
  TrackedDocumentInspection,
} from './types.js';

export interface SaveTrackChangesBody {
  on?: boolean;
  on_for?: Record<string, boolean>;
  on_for_guests?: boolean;
}

export interface ChangesServiceHost {
  currentUserId?: string;
  openProjectSession(projectId: string): Promise<ProjectSession>;
  saveTrackChanges(projectId: string, body: SaveTrackChangesBody): Promise<void>;
  acceptShareJsChanges(
    projectId: string,
    docId: string,
    changeIds: string[]
  ): Promise<void>;
}

interface PreparedSuggestion {
  preview: SuggestionPreview;
  mutation: AdapterMutation;
  snapshot: JoinedDocument;
  beforeChanges: TrackedChange[];
  priorState: TrackChangesState;
}

interface PreparedResolution {
  preview: ChangeResolutionPreview;
  selectedChanges: TrackedChange[];
  beforeChanges: TrackedChange[];
  resolution: AdapterResolution;
}

function stateEnabledForUser(state: TrackChangesState, userId: string): boolean {
  return state === true || (typeof state === 'object' && state[userId] === true);
}

function stateWithUserEnabled(state: TrackChangesState, userId: string): TrackChangesState {
  if (state === true) return true;
  if (state === false) return { [userId]: true };
  return { ...state, [userId]: true };
}

function stateToRequestBody(state: TrackChangesState): SaveTrackChangesBody {
  if (typeof state === 'boolean') return { on: state };
  const { __guests__, ...members } = state;
  return {
    on_for: members,
    ...(typeof __guests__ === 'boolean' ? { on_for_guests: __guests__ } : {}),
  };
}

function stateToRestoreBody(
  state: TrackChangesState,
  temporaryUserId: string
): SaveTrackChangesBody {
  if (state === true) return { on: true };
  if (state === false) {
    // The API's global `on: false` does not clear an existing per-user entry.
    // The editor restores Editing mode by explicitly toggling that user off.
    return { on_for: { [temporaryUserId]: false } };
  }
  const { __guests__, ...members } = state;
  if (!(temporaryUserId in members)) members[temporaryUserId] = false;
  return {
    on_for: members,
    ...(typeof __guests__ === 'boolean' ? { on_for_guests: __guests__ } : {}),
  };
}

function statesEqual(left: TrackChangesState | undefined, right: TrackChangesState): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
  if (!left) return false;
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof OlcliError) {
    return { name: error.name, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

function changeIdentity(change: TrackedChange): string {
  return JSON.stringify({
    id: change.id,
    kind: change.kind,
    position: change.position,
    snapshotPosition: change.snapshotPosition,
    text: change.text,
    authorId: change.authorId,
    timestamp: change.timestamp,
  });
}

function expectedResolutionText(
  content: string,
  changes: TrackedChange[],
  action: ResolveChangesInput['action']
): string {
  if (action === 'accept') return content;

  let result = content;
  const ordered = [...changes].sort(
    (left, right) => right.position - left.position || right.id.localeCompare(left.id)
  );
  for (const change of ordered) {
    if (change.kind === 'insert') {
      if (result.slice(change.position, change.position + change.text.length) !== change.text) {
        throw new OlcliError('SOURCE_MISMATCH', 'Tracked insertion no longer matches document text.', {
          details: { changeId: change.id, position: change.position },
        });
      }
      result = result.slice(0, change.position)
        + result.slice(change.position + change.text.length);
    } else {
      result = result.slice(0, change.position) + change.text + result.slice(change.position);
    }
  }
  return result;
}

export class ChangesService {
  private readonly host: ChangesServiceHost;

  constructor(host: ChangesServiceHost) {
    this.host = host;
  }

  async inspectTrackedDocument(
    projectId: string,
    filePath: string
  ): Promise<TrackedDocumentInspection> {
    const session = await this.host.openProjectSession(projectId);
    try {
      const documentSession = session.openDocumentByPath(filePath);
      const snapshot = await documentSession.join();
      const adapter = getTrackedChangesAdapter(snapshot.type);
      return {
        projectId,
        docId: snapshot.docId,
        path: documentSession.path || filePath.replace(/^\/+/, ''),
        otType: snapshot.type,
        version: snapshot.version,
        textSha256: sha256Text(adapter.getEditorContent(snapshot)),
      };
    } finally {
      await session.close();
    }
  }

  async previewTrackedSuggestion(input: SuggestChangeInput): Promise<SuggestionPreview> {
    const session = await this.host.openProjectSession(input.projectId);
    try {
      return (await this.prepare(session, input)).preview;
    } finally {
      await session.close();
    }
  }

  async suggestTrackedChange(input: SuggestChangeInput): Promise<SuggestionResult> {
    const session = await this.host.openProjectSession(input.projectId);
    let stateChanged = false;
    let prepared: PreparedSuggestion | undefined;
    let result: SuggestionResult | undefined;
    let operationError: unknown;
    let restoreError: unknown;

    try {
      prepared = await this.prepare(session, input);
      const documentSession = session.openDocumentByPath(input.filePath);
      const refreshed = await documentSession.join();

      this.assertSnapshotPreconditions(refreshed, prepared.preview, input);
      this.assertNoAdjacentTrackedChanges(prepared.preview, prepared.beforeChanges);

      const currentUserId = this.host.currentUserId!;
      if (!stateEnabledForUser(prepared.priorState, currentUserId)) {
        const enabledState = stateWithUserEnabled(prepared.priorState, currentUserId);
        await this.host.saveTrackChanges(input.projectId, stateToRequestBody(enabledState));
        stateChanged = true;
        await this.assertProjectState(input.projectId, enabledState, 'enable');
      }

      await documentSession.submit({
        operations: prepared.mutation.operations,
        expectedVersion: refreshed.version,
        metadata: prepared.mutation.metadata,
      });

      const after = await documentSession.refresh();
      const adapter = getTrackedChangesAdapter(after.type);
      const afterChanges = adapter.listChanges(after, prepared.preview.path);
      const beforeIds = new Set(prepared.beforeChanges.map(change => change.id));
      const newChanges = afterChanges.filter(change => !beforeIds.has(change.id));
      const refreshedEditorContent = adapter.getEditorContent(refreshed);
      const afterEditorContent = adapter.getEditorContent(after);
      const expectedText = refreshedEditorContent.slice(0, prepared.preview.position)
        + input.newText
        + refreshedEditorContent.slice(prepared.preview.position + input.oldText.length);

      if (
        afterEditorContent !== expectedText
        || sha256Text(afterEditorContent) !== prepared.preview.expectedResultSha256
      ) {
        throw new OlcliError('VERIFICATION_FAILED', 'Document text did not match the targeted suggestion result.', {
          details: {
            expectedSha256: prepared.preview.expectedResultSha256,
            actualSha256: sha256Text(afterEditorContent),
          },
        });
      }
      for (const expected of prepared.mutation.normalizedOperations) {
        const found = newChanges.some(change => (
          change.kind === expected.kind
          && change.position === expected.position
          && change.text === expected.text
        ));
        if (!found) {
          throw new OlcliError('VERIFICATION_FAILED', 'Expected native tracked-change range was not created.', {
            details: { kind: expected.kind, position: expected.position, textLength: expected.text.length },
          });
        }
      }

      result = {
        ...prepared.preview,
        beforeVersion: refreshed.version,
        afterVersion: after.version,
        changeIds: newChanges.map(change => change.id),
        verified: true,
        trackChangesStateRestored: !stateChanged,
      };
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await session.close();
      } catch (error) {
        // A cleanup failure must never prevent restoration of project state.
        // Preserve an earlier operation failure because it is more actionable.
        if (!operationError && !result) operationError = error;
      }
      if (stateChanged && prepared) {
        try {
          await this.host.saveTrackChanges(
            input.projectId,
            stateToRestoreBody(prepared.priorState, this.host.currentUserId!)
          );
          await this.assertProjectState(input.projectId, prepared.priorState, 'restore');
          if (result) result.trackChangesStateRestored = true;
        } catch (error) {
          restoreError = error;
        }
      }
    }

    if (operationError && restoreError) {
      throw new OlcliError('PARTIAL_FAILURE', 'Suggestion failed and the prior tracked-changes state could not be restored.', {
        details: {
          operationError: errorSummary(operationError),
          restoreError: errorSummary(restoreError),
        },
      });
    }
    if (operationError) throw operationError;
    if (restoreError) {
      throw new OlcliError('STATE_RESTORE_FAILED', 'Suggestion was submitted, but tracked-changes state restoration failed.', {
        cause: restoreError,
        details: {
          verified: result?.verified === true,
          changeIds: result?.changeIds,
          beforeVersion: result?.beforeVersion,
          afterVersion: result?.afterVersion,
          priorState: prepared?.priorState,
          restoreError: errorSummary(restoreError),
        },
      });
    }
    if (!result) throw new OlcliError('VERIFICATION_FAILED', 'Suggestion completed without a result.');
    return result;
  }

  async previewTrackedResolution(
    input: ResolveChangesInput
  ): Promise<ChangeResolutionPreview> {
    const session = await this.host.openProjectSession(input.projectId);
    try {
      return (await this.prepareResolution(session, input)).preview;
    } finally {
      await session.close();
    }
  }

  async resolveTrackedChanges(
    input: ResolveChangesInput
  ): Promise<ChangeResolutionResult> {
    const session = await this.host.openProjectSession(input.projectId);
    try {
      const prepared = await this.prepareResolution(session, input);
      const documentSession = session.openDocumentByPath(input.filePath);
      const refreshed = await documentSession.join();
      const adapter = getTrackedChangesAdapter(refreshed.type);
      const editorContent = adapter.getEditorContent(refreshed);

      if (refreshed.version !== prepared.preview.version) {
        throw new OlcliError('VERSION_CONFLICT', 'Document changed after change selection.', {
          details: {
            expectedVersion: prepared.preview.version,
            actualVersion: refreshed.version,
          },
        });
      }
      if (sha256Text(editorContent) !== prepared.preview.textSha256) {
        throw new OlcliError('SOURCE_MISMATCH', 'Document text changed after change selection.');
      }

      const refreshedChanges = adapter.listChanges(refreshed, prepared.preview.path);
      const refreshedSelected = this.selectChanges(refreshedChanges, input.changeIds);
      if (
        refreshedSelected.map(changeIdentity).sort().join('\n')
        !== prepared.selectedChanges.map(changeIdentity).sort().join('\n')
      ) {
        throw new OlcliError('SOURCE_MISMATCH', 'Selected tracked changes changed before submission.');
      }

      const resolution = adapter.buildTrackedResolution(
        refreshed,
        refreshedSelected,
        input.action
      );
      if (resolution.transport === 'legacy-accept-endpoint') {
        await this.host.acceptShareJsChanges(
          input.projectId,
          refreshed.docId,
          input.changeIds
        );
      } else {
        await documentSession.submit({
          operations: resolution.operations,
          expectedVersion: refreshed.version,
        });
      }

      const after = await documentSession.refresh();
      const afterAdapter = getTrackedChangesAdapter(after.type);
      const afterContent = afterAdapter.getEditorContent(after);
      const afterChanges = afterAdapter.listChanges(after, prepared.preview.path);
      const afterIds = new Set(afterChanges.map(change => change.id));
      const requestedStillPresent = input.changeIds.filter(id => afterIds.has(id));
      if (requestedStillPresent.length > 0) {
        throw new OlcliError('VERIFICATION_FAILED', 'Requested tracked-change IDs remain after resolution.', {
          details: { changeIds: requestedStillPresent },
        });
      }
      if (sha256Text(afterContent) !== prepared.preview.expectedResultSha256) {
        throw new OlcliError('VERIFICATION_FAILED', 'Resolved document text did not match the predicted result.', {
          details: {
            expectedSha256: prepared.preview.expectedResultSha256,
            actualSha256: sha256Text(afterContent),
          },
        });
      }

      if (after.type === 'sharejs-text-ot') {
        const selectedIds = new Set(input.changeIds);
        const missingUnselected = prepared.beforeChanges
          .filter(change => !selectedIds.has(change.id))
          .map(change => change.id)
          .filter(id => !afterIds.has(id));
        if (missingUnselected.length > 0) {
          throw new OlcliError('VERIFICATION_FAILED', 'Unselected tracked changes disappeared.', {
            details: { changeIds: missingUnselected },
          });
        }
      }

      return {
        ...prepared.preview,
        beforeVersion: refreshed.version,
        afterVersion: after.version,
        verified: true,
        remainingChangeIds: afterChanges.map(change => change.id),
      };
    } finally {
      await session.close();
    }
  }

  private async prepareResolution(
    session: ProjectSession,
    input: ResolveChangesInput
  ): Promise<PreparedResolution> {
    if (input.action !== 'accept' && input.action !== 'reject') {
      throw new OlcliError('PROTOCOL_ERROR', `Unsupported resolution action: ${input.action}`);
    }
    if (!Array.isArray(input.changeIds) || input.changeIds.length === 0) {
      throw new OlcliError('CHANGE_NOT_FOUND', 'At least one explicit change ID is required.');
    }
    const uniqueIds = new Set(input.changeIds);
    if (uniqueIds.size !== input.changeIds.length) {
      throw new OlcliError('AMBIGUOUS_CHANGE_ID', 'Duplicate change IDs are not allowed.');
    }

    const documentSession = session.openDocumentByPath(input.filePath);
    const snapshot = await documentSession.join();
    const path = documentSession.path || input.filePath.replace(/^\/+/, '');
    const capabilities = detectChangesCapabilities(
      session,
      snapshot,
      path,
      this.host.currentUserId
    );
    if (!capabilities.canTrackedWrite) {
      throw new OlcliError('PERMISSION_DENIED', 'Current project permissions cannot resolve tracked changes.');
    }

    const adapter = getTrackedChangesAdapter(snapshot.type);
    const editorContent = adapter.getEditorContent(snapshot);
    const textSha256 = sha256Text(editorContent);
    if (
      input.precondition?.expectedVersion !== undefined
      && input.precondition.expectedVersion !== snapshot.version
    ) {
      throw new OlcliError('VERSION_CONFLICT', 'Document version does not match the requested precondition.', {
        details: {
          expectedVersion: input.precondition.expectedVersion,
          actualVersion: snapshot.version,
        },
      });
    }
    if (
      input.precondition?.expectedTextSha256
      && input.precondition.expectedTextSha256.toLowerCase() !== textSha256
    ) {
      throw new OlcliError('SOURCE_MISMATCH', 'Document hash does not match the requested precondition.', {
        details: {
          expectedSha256: input.precondition.expectedTextSha256,
          actualSha256: textSha256,
        },
      });
    }

    const beforeChanges = adapter.listChanges(snapshot, path);
    const selectedChanges = this.selectChanges(beforeChanges, input.changeIds);
    const resolution = adapter.buildTrackedResolution(snapshot, selectedChanges, input.action);
    const expectedText = expectedResolutionText(editorContent, selectedChanges, input.action);

    return {
      preview: {
        projectId: input.projectId,
        docId: snapshot.docId,
        path,
        otType: snapshot.type,
        action: input.action,
        version: snapshot.version,
        textSha256,
        changeIds: [...input.changeIds],
        changes: selectedChanges.map(change => ({
          id: change.id,
          kind: change.kind,
          position: change.position,
          text: change.text,
        })),
        expectedResultSha256: sha256Text(expectedText),
        transport: resolution.transport,
      },
      selectedChanges,
      beforeChanges,
      resolution,
    };
  }

  private selectChanges(
    available: TrackedChange[],
    changeIds: string[]
  ): TrackedChange[] {
    return changeIds.map(id => {
      const matches = available.filter(change => change.id === id);
      if (matches.length === 0) {
        throw new OlcliError('CHANGE_NOT_FOUND', `Tracked change not found: ${id}`, {
          details: { changeId: id },
        });
      }
      if (matches.length > 1) {
        throw new OlcliError('AMBIGUOUS_CHANGE_ID', `Tracked change ID is ambiguous: ${id}`, {
          details: { changeId: id, matchCount: matches.length },
        });
      }
      return matches[0];
    });
  }

  private async prepare(
    session: ProjectSession,
    input: SuggestChangeInput
  ): Promise<PreparedSuggestion> {
    const documentSession = session.openDocumentByPath(input.filePath);
    const snapshot = await documentSession.join();
    const path = documentSession.path || input.filePath.replace(/^\/+/, '');
    const capabilities = detectChangesCapabilities(
      session,
      snapshot,
      path,
      this.host.currentUserId
    );

    if (!capabilities.featureAvailable) {
      throw new OlcliError('TRACK_CHANGES_UNAVAILABLE', 'Tracked changes are unavailable for this project.');
    }
    if (!capabilities.trackChangesStateReadable || capabilities.trackChangesState === undefined) {
      throw new OlcliError('TRACK_CHANGES_STATE_UNREADABLE', 'Tracked-changes state is unavailable or malformed.');
    }
    if (!capabilities.canTrackedWrite) {
      throw new OlcliError('PERMISSION_DENIED', 'Current project permissions cannot create tracked suggestions.');
    }
    if (!this.host.currentUserId) {
      throw new OlcliError('PERMISSION_DENIED', 'The authenticated Overleaf user ID could not be determined.');
    }
    const adapter = getTrackedChangesAdapter(snapshot.type);
    const editorContent = adapter.getEditorContent(snapshot);
    const textSha256 = sha256Text(editorContent);
    if (
      input.precondition?.expectedVersion !== undefined
      && input.precondition.expectedVersion !== snapshot.version
    ) {
      throw new OlcliError('VERSION_CONFLICT', 'Document version does not match the requested precondition.', {
        details: {
          expectedVersion: input.precondition.expectedVersion,
          actualVersion: snapshot.version,
        },
      });
    }
    if (
      input.precondition?.expectedTextSha256
      && input.precondition.expectedTextSha256.toLowerCase() !== textSha256
    ) {
      throw new OlcliError('SOURCE_MISMATCH', 'Document hash does not match the requested precondition.', {
        details: { expectedSha256: input.precondition.expectedTextSha256, actualSha256: textSha256 },
      });
    }

    const position = resolveTextMatchPosition(editorContent, input);
    const location = positionToLineColumn(editorContent, position);
    const mutation = adapter.buildTrackedReplacement(
      snapshot,
      position,
      input.oldText,
      input.newText,
      {
        trackChangeSeed: generateTrackChangeSeed(),
        currentUserId: this.host.currentUserId,
        timestamp: new Date(),
      }
    );
    const expectedText = editorContent.slice(0, position)
      + input.newText
      + editorContent.slice(position + input.oldText.length);
    const beforeChanges = adapter.listChanges(snapshot, path);

    return {
      preview: {
        projectId: input.projectId,
        docId: snapshot.docId,
        path,
        otType: snapshot.type,
        version: snapshot.version,
        textSha256,
        position,
        ...location,
        oldText: input.oldText,
        newText: input.newText,
        operations: mutation.normalizedOperations,
        expectedResultSha256: sha256Text(expectedText),
      },
      mutation,
      snapshot,
      beforeChanges,
      priorState: capabilities.trackChangesState,
    };
  }

  private assertSnapshotPreconditions(
    refreshed: JoinedDocument,
    preview: SuggestionPreview,
    input: SuggestChangeInput
  ): void {
    if (refreshed.version !== preview.version) {
      throw new OlcliError('VERSION_CONFLICT', 'Document changed after the suggestion was prepared.', {
        details: { expectedVersion: preview.version, actualVersion: refreshed.version },
      });
    }
    const editorContent = getTrackedChangesAdapter(refreshed.type).getEditorContent(refreshed);
    const actualSha256 = sha256Text(editorContent);
    if (actualSha256 !== preview.textSha256) {
      throw new OlcliError('SOURCE_MISMATCH', 'Document content changed after the suggestion was prepared.', {
        details: { expectedSha256: preview.textSha256, actualSha256 },
      });
    }
    if (editorContent.slice(preview.position, preview.position + input.oldText.length) !== input.oldText) {
      throw new OlcliError('SOURCE_MISMATCH', 'Matched source text changed before submission.', {
        details: { position: preview.position, expectedLength: input.oldText.length },
      });
    }
  }

  private assertNoAdjacentTrackedChanges(
    preview: SuggestionPreview,
    changes: TrackedChange[]
  ): void {
    const start = preview.position;
    const end = preview.position + Math.max(1, preview.oldText.length);
    const conflict = changes.find(change => change.position >= start - 1 && change.position <= end + 1);
    if (conflict) {
      throw new OlcliError(
        'SOURCE_MISMATCH',
        'The target overlaps or touches an existing tracked change; choose an isolated passage.',
        { details: { changeId: conflict.id, position: conflict.position } }
      );
    }
  }

  private async assertProjectState(
    projectId: string,
    expected: TrackChangesState,
    stage: 'enable' | 'restore'
  ): Promise<void> {
    const verificationSession = await this.host.openProjectSession(projectId);
    try {
      const observed = readTrackChangesProjectState(verificationSession);
      if (!observed.present || !statesEqual(observed.state, expected)) {
        const code = stage === 'restore' ? 'STATE_RESTORE_FAILED' : 'VERIFICATION_FAILED';
        throw new OlcliError(code, `Tracked-changes state ${stage} verification failed.`, {
          details: { stage },
        });
      }
    } finally {
      await verificationSession.close();
    }
  }
}
