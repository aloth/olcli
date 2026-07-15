interface HistoryRange {
  pos: number;
  length: number;
}

export interface RawHistoryTrackedChange {
  range: HistoryRange;
  tracking: {
    type: 'insert' | 'delete';
    userId?: string;
    ts?: unknown;
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseRawHistoryTrackedChanges(value: unknown): RawHistoryTrackedChange[] {
  if (!Array.isArray(value)) return [];

  return value.filter((candidate): candidate is RawHistoryTrackedChange => {
    if (!candidate || typeof candidate !== 'object') return false;
    const change = candidate as {
      range?: { pos?: unknown; length?: unknown };
      tracking?: { type?: unknown };
    };
    return isNonNegativeInteger(change.range?.pos)
      && isNonNegativeInteger(change.range?.length)
      && (change.range?.length as number) > 0
      && (change.tracking?.type === 'insert' || change.tracking?.type === 'delete');
  });
}

function sortedDeletes(changes: RawHistoryTrackedChange[]): RawHistoryTrackedChange[] {
  return changes
    .filter(change => change.tracking.type === 'delete')
    .sort((a, b) => a.range.pos - b.range.pos);
}

/** Convert a history snapshot offset into the visible editor offset. */
export function historySnapshotToEditorPosition(
  snapshotPosition: number,
  changes: RawHistoryTrackedChange[]
): number {
  let deletedBefore = 0;
  for (const change of sortedDeletes(changes)) {
    const start = change.range.pos;
    const end = start + change.range.length;
    if (snapshotPosition < start) break;
    if (snapshotPosition <= end) return start - deletedBefore;
    deletedBefore += change.range.length;
  }
  return snapshotPosition - deletedBefore;
}

/** Return the editor-visible text by filtering tracked deletions from a snapshot. */
export function historySnapshotToEditorText(
  snapshotText: string,
  changes: RawHistoryTrackedChange[]
): string {
  let cursor = 0;
  let result = '';
  for (const change of sortedDeletes(changes)) {
    const start = Math.max(cursor, Math.min(snapshotText.length, change.range.pos));
    const end = Math.max(start, Math.min(snapshotText.length, change.range.pos + change.range.length));
    if (cursor < start) result += snapshotText.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  if (cursor < snapshotText.length) result += snapshotText.slice(cursor);
  return result;
}

/** Convert a visible editor offset into the corresponding history snapshot offset. */
export function historyEditorToSnapshotPosition(
  editorPosition: number,
  changes: RawHistoryTrackedChange[]
): number {
  let offset = 0;
  for (const change of sortedDeletes(changes)) {
    const editorBoundary = change.range.pos - offset + 1;
    if (editorPosition < editorBoundary) break;
    offset += change.range.length;
  }
  return editorPosition + offset;
}
