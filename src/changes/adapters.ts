import { OlcliError } from '../errors/olcli-error.js';
import {
  buildCommentContext,
  positionToLineColumn,
} from '../comments/range-parser.js';
import type { JoinedDocument, OverleafOtType } from '../realtime/types.js';
import {
  historySnapshotToEditorPosition,
  historySnapshotToEditorText,
  historyEditorToSnapshotPosition,
  parseRawHistoryTrackedChanges,
} from './history-offsets.js';
import type {
  AdapterMutation,
  AdapterResolution,
  BuildTrackedReplacementOptions,
  ChangeResolutionAction,
  TrackedChange,
  TrackedChangesAdapter,
  TrackedChangesAdapterOptions,
} from './types.js';

function containsNonBmpCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) return true;
  }
  return false;
}

function appendHistoryScanOperation(
  operations: unknown[],
  operation: unknown
): void {
  if (typeof operation === 'number' && operation === 0) return;
  if (operation === '') return;
  operations.push(operation);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.valueOf())) return timestamp.toISOString();
  }
  return undefined;
}

function makeLocation(
  visibleText: string,
  position: number,
  contextLines: number
): Pick<TrackedChange, 'line' | 'column' | 'context'> {
  const location = positionToLineColumn(visibleText, position);
  return {
    ...location,
    context: buildCommentContext(visibleText, location.line, contextLines),
  };
}

class ShareJsTrackedChangesAdapter implements TrackedChangesAdapter {
  readonly otType = 'sharejs-text-ot' as const;

  listChanges(
    document: JoinedDocument,
    path: string,
    options: TrackedChangesAdapterOptions = {}
  ): TrackedChange[] {
    const contextLines = options.contextLines ?? 0;
    const rawChanges = Array.isArray(document.ranges?.changes)
      ? document.ranges.changes
      : [];
    const result: TrackedChange[] = [];

    for (const raw of rawChanges) {
      if (!raw || typeof raw !== 'object') continue;
      const change = raw as {
        id?: unknown;
        op?: { p?: unknown; i?: unknown; d?: unknown };
        metadata?: { user_id?: unknown; ts?: unknown };
      };
      if (typeof change.id !== 'string' || !Number.isSafeInteger(change.op?.p)) continue;

      const position = change.op?.p as number;
      if (position < 0) continue;
      const kind = typeof change.op?.i === 'string'
        ? 'insert'
        : typeof change.op?.d === 'string'
          ? 'delete'
          : undefined;
      if (!kind) continue;
      const text = kind === 'insert' ? change.op?.i as string : change.op?.d as string;

      result.push({
        id: change.id,
        docId: document.docId,
        path,
        otType: this.otType,
        kind,
        position,
        text,
        authorId: typeof change.metadata?.user_id === 'string'
          ? change.metadata.user_id
          : undefined,
        timestamp: normalizeTimestamp(change.metadata?.ts),
        ...makeLocation(document.content, position, contextLines),
        raw: options.includeRaw ? raw : undefined,
      });
    }

    return result.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  getEditorContent(document: JoinedDocument): string {
    return document.content;
  }

  buildTrackedReplacement(
    _document: JoinedDocument,
    position: number,
    oldText: string,
    newText: string,
    options: BuildTrackedReplacementOptions
  ): AdapterMutation {
    const operations: unknown[] = [];
    const normalizedOperations: AdapterMutation['normalizedOperations'] = [];

    // Match Overleaf's editor behavior: insert replacement text first, then
    // delete the displaced old text at its shifted position.
    if (newText.length > 0) {
      operations.push({ p: position, i: newText });
      normalizedOperations.push({ kind: 'insert', position, text: newText });
    }
    if (oldText.length > 0) {
      const deletePosition = position + newText.length;
      operations.push({ p: deletePosition, d: oldText });
      normalizedOperations.push({ kind: 'delete', position: deletePosition, text: oldText });
    }

    return {
      operations,
      normalizedOperations,
      metadata: { tc: options.trackChangeSeed },
    };
  }

  buildTrackedResolution(
    _document: JoinedDocument,
    changes: TrackedChange[],
    action: ChangeResolutionAction
  ): AdapterResolution {
    if (action === 'accept') {
      return { transport: 'legacy-accept-endpoint', operations: [] };
    }

    const operations = [...changes]
      .sort((left, right) => right.position - left.position || right.id.localeCompare(left.id))
      .map(change => change.kind === 'insert'
        ? { p: change.position, d: change.text, u: true }
        : { p: change.position, i: change.text, u: true });
    return { transport: 'ot', operations };
  }
}

class HistoryOtTrackedChangesAdapter implements TrackedChangesAdapter {
  readonly otType = 'history-ot' as const;

  listChanges(
    document: JoinedDocument,
    path: string,
    options: TrackedChangesAdapterOptions = {}
  ): TrackedChange[] {
    const contextLines = options.contextLines ?? 0;
    const rawChanges = parseRawHistoryTrackedChanges(document.ranges?.trackedChanges);
    const visibleText = historySnapshotToEditorText(document.content, rawChanges);

    return rawChanges.map(raw => {
      const snapshotPosition = raw.range.pos;
      const position = historySnapshotToEditorPosition(snapshotPosition, rawChanges);
      const kind = raw.tracking.type;
      const text = document.content.slice(snapshotPosition, snapshotPosition + raw.range.length);
      return {
        // This is the same identity currently constructed by Overleaf's review panel.
        id: `change-${kind}-${position}`,
        docId: document.docId,
        path,
        otType: this.otType,
        kind,
        position,
        snapshotPosition,
        text,
        authorId: typeof raw.tracking.userId === 'string'
          ? raw.tracking.userId
          : undefined,
        timestamp: normalizeTimestamp(raw.tracking.ts),
        ...makeLocation(visibleText, position, contextLines),
        raw: options.includeRaw ? raw : undefined,
      } satisfies TrackedChange;
    }).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  getEditorContent(document: JoinedDocument): string {
    const rawChanges = parseRawHistoryTrackedChanges(document.ranges?.trackedChanges);
    return historySnapshotToEditorText(document.content, rawChanges);
  }

  buildTrackedReplacement(
    document: JoinedDocument,
    position: number,
    oldText: string,
    newText: string,
    options: BuildTrackedReplacementOptions
  ): AdapterMutation {
    if (containsNonBmpCharacters(newText)) {
      throw new OlcliError(
        'UNSUPPORTED_OT_TYPE',
        'history-ot does not accept inserted non-BMP characters.',
        { details: { otType: this.otType, operation: 'suggest' } }
      );
    }

    const rawChanges = parseRawHistoryTrackedChanges(document.ranges?.trackedChanges);
    const snapshotStart = historyEditorToSnapshotPosition(position, rawChanges);
    const snapshotEnd = historyEditorToSnapshotPosition(position + oldText.length, rawChanges);
    if (document.content.slice(snapshotStart, snapshotEnd) !== oldText) {
      throw new OlcliError(
        'SOURCE_MISMATCH',
        'The target crosses an existing history-ot tracked deletion.',
        { details: { position, expectedLength: oldText.length } }
      );
    }

    const timestamp = options.timestamp.toISOString();
    const textOperation: unknown[] = [];
    appendHistoryScanOperation(textOperation, snapshotStart);
    if (newText.length > 0) {
      appendHistoryScanOperation(textOperation, {
        i: newText,
        tracking: {
          type: 'insert',
          userId: options.currentUserId,
          ts: timestamp,
        },
      });
    }
    if (oldText.length > 0) {
      appendHistoryScanOperation(textOperation, {
        r: snapshotEnd - snapshotStart,
        tracking: {
          type: 'delete',
          userId: options.currentUserId,
          ts: timestamp,
        },
      });
    }
    appendHistoryScanOperation(textOperation, document.content.length - snapshotEnd);

    return {
      operations: [{ textOperation }],
      normalizedOperations: [
        ...(newText.length > 0 ? [{ kind: 'insert' as const, position, text: newText }] : []),
        ...(oldText.length > 0
          ? [{ kind: 'delete' as const, position: position + newText.length, text: oldText }]
          : []),
      ],
      metadata: {},
    };
  }

  buildTrackedResolution(
    document: JoinedDocument,
    changes: TrackedChange[],
    action: ChangeResolutionAction
  ): AdapterResolution {
    const ordered = [...changes].sort(
      (left, right) => (left.snapshotPosition ?? -1) - (right.snapshotPosition ?? -1)
        || left.id.localeCompare(right.id)
    );
    const textOperation: unknown[] = [];
    let cursor = 0;

    for (const change of ordered) {
      const start = change.snapshotPosition;
      if (start === undefined || start < cursor) {
        throw new OlcliError(
          'PROTOCOL_ERROR',
          'history-ot change ranges are missing or overlapping.',
          { details: { changeId: change.id } }
        );
      }
      appendHistoryScanOperation(textOperation, start - cursor);
      const remove = (action === 'accept' && change.kind === 'delete')
        || (action === 'reject' && change.kind === 'insert');
      if (remove) {
        appendHistoryScanOperation(textOperation, -change.text.length);
      } else {
        appendHistoryScanOperation(textOperation, {
          r: change.text.length,
          tracking: { type: 'none' },
        });
      }
      cursor = start + change.text.length;
    }

    appendHistoryScanOperation(textOperation, document.content.length - cursor);
    return {
      transport: 'ot',
      operations: [{ textOperation }],
    };
  }
}

class UnsupportedTrackedChangesAdapter implements TrackedChangesAdapter {
  readonly otType: OverleafOtType;

  constructor(otType: OverleafOtType) {
    this.otType = otType;
  }

  listChanges(): TrackedChange[] {
    throw new OlcliError('UNSUPPORTED_OT_TYPE', `Unsupported document OT type: ${this.otType}`, {
      details: { otType: this.otType },
    });
  }

  getEditorContent(): string {
    throw new OlcliError('UNSUPPORTED_OT_TYPE', `Unsupported document OT type: ${this.otType}`);
  }

  buildTrackedReplacement(): AdapterMutation {
    throw new OlcliError('UNSUPPORTED_OT_TYPE', `Unsupported document OT type: ${this.otType}`, {
      details: { otType: this.otType, operation: 'suggest' },
    });
  }

  buildTrackedResolution(): AdapterResolution {
    throw new OlcliError('UNSUPPORTED_OT_TYPE', `Unsupported document OT type: ${this.otType}`, {
      details: { otType: this.otType, operation: 'resolve' },
    });
  }
}

const shareJsAdapter = new ShareJsTrackedChangesAdapter();
const historyOtAdapter = new HistoryOtTrackedChangesAdapter();

export function getTrackedChangesAdapter(otType: OverleafOtType): TrackedChangesAdapter {
  if (otType === 'sharejs-text-ot') return shareJsAdapter;
  if (otType === 'history-ot') return historyOtAdapter;
  return new UnsupportedTrackedChangesAdapter(otType);
}
