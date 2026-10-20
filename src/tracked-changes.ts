/**
 * Tracked changes: the insertions and deletions Overleaf records while track
 * changes is on, shown as suggestions in the review panel.
 *
 * Pure functions only, for the same reason as `diff.ts` and `rename-plan.ts`:
 * everything decided here is decided from the data a doc join returns, so it
 * is unit-testable without an Overleaf account. The network side lives in
 * `client.ts`.
 *
 * Two document formats exist, and they store tracked changes differently:
 *
 * - `sharejs-text-ot` docs carry `ranges.changes`, each
 *   `{ id, op: { i | d, p }, metadata: { user_id, ts } }`. `p` is an offset
 *   into the visible text. Tracked-deleted text is no longer in the doc at
 *   all; it survives only in `op.d`.
 * - `history-ot` docs carry a StringFileData snapshot whose `content` still
 *   contains the tracked-deleted text, with `trackedChanges` given as
 *   `{ range: { pos, length }, tracking: { type, userId, ts } }` over that
 *   content. The server assigns these no ids. The Overleaf editor derives
 *   `change-<type>-<visible position>` and this module does the same, so the
 *   ids are only stable until the doc is next edited.
 *
 * Positions reported by this module are always offsets into the visible text,
 * which is what the editor shows and what `olcli pull` downloads, so a
 * position means the same thing for both formats.
 */

import { createTwoFilesPatch } from 'diff';

export type TrackedChangeKind = 'insert' | 'delete';

/** One tracked change as stored in a single doc, before any project context is added. */
export interface DocTrackedChange {
  id: string;
  kind: TrackedChangeKind;
  /** Offset into the visible text, tracked deletes excluded. */
  position: number;
  /** Inserted text for an insert, removed text for a delete. */
  text: string;
  /** Null when Overleaf recorded no user, e.g. edits written by a sync integration. */
  userId: string | null;
  timestamp?: string;
}

export interface TrackedChangeAuthor {
  id: string | null;
  name?: string;
  email?: string;
}

export interface ReviewUser {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

/** A ShareJS text op component, the format `applyOtUpdate` takes for sharejs-text-ot docs. */
export interface ShareJsTextOp {
  p: number;
  i?: string;
  d?: string;
  /**
   * Marks the op as an undo. The ranges tracker uses it to recognize an
   * insertion that restores a tracked deletion and drop that deletion,
   * rather than shift it along as if new text had been typed in front of it.
   * The Overleaf editor sets it on every op it sends to reject a change.
   */
  u?: boolean;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || value instanceof Date) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

/**
 * Read `ranges.changes` of a sharejs-text-ot doc. The texts must already be
 * decoded: with `encodeRanges` the join sends `op.i` and `op.d` as UTF-8
 * bytes in a binary string, exactly like the doc lines.
 *
 * Order is preserved. It is the ranges tracker's order, which `planRejection`
 * relies on to order changes that share a position.
 */
export function parseShareJsChanges(ranges: any): DocTrackedChange[] {
  const changes: DocTrackedChange[] = [];
  for (const change of ranges?.changes ?? []) {
    const op = change?.op;
    if (typeof change?.id !== 'string' || !op || typeof op.p !== 'number') continue;
    const userId = typeof change.metadata?.user_id === 'string' ? change.metadata.user_id : null;
    const timestamp = normalizeTimestamp(change.metadata?.ts);
    if (typeof op.i === 'string') {
      changes.push({ id: change.id, kind: 'insert', position: op.p, text: op.i, userId, timestamp });
    } else if (typeof op.d === 'string') {
      changes.push({ id: change.id, kind: 'delete', position: op.p, text: op.d, userId, timestamp });
    }
  }
  return changes;
}

interface HistoryOtTrackedChange {
  range: { pos: number; length: number };
  tracking: { type: string; userId?: string; ts?: string };
}

function isHistoryOtTrackedChange(value: any): value is HistoryOtTrackedChange {
  return typeof value?.range?.pos === 'number'
    && typeof value?.range?.length === 'number'
    && (value?.tracking?.type === 'insert' || value?.tracking?.type === 'delete');
}

/**
 * Read the tracked changes of a history-ot snapshot and compute the visible
 * text. Mirrors `buildRangesFromSnapshot` in the Overleaf web frontend,
 * including how it derives change ids.
 */
export function parseHistoryOtChanges(snapshot: any): { changes: DocTrackedChange[]; visibleContent: string } {
  const content = typeof snapshot?.content === 'string' ? snapshot.content : '';
  const tracked = ((snapshot?.trackedChanges ?? []) as unknown[])
    .filter(isHistoryOtTrackedChange)
    .sort((a, b) => a.range.pos - b.range.pos);
  const deletes = tracked.filter(change => change.tracking.type === 'delete');

  // A snapshot position inside or after a tracked delete moves back by the
  // part of that delete in front of it; inside one it lands on its start.
  const toVisible = (pos: number): number => {
    let shift = 0;
    for (const change of deletes) {
      if (change.range.pos >= pos) break;
      shift += Math.min(change.range.pos + change.range.length, pos) - change.range.pos;
    }
    return pos - shift;
  };

  let visibleContent = '';
  let cursor = 0;
  for (const change of deletes) {
    if (change.range.pos < cursor) continue;
    visibleContent += content.slice(cursor, change.range.pos);
    cursor = change.range.pos + change.range.length;
  }
  visibleContent += content.slice(cursor);

  const changes = tracked.map(change => {
    const position = toVisible(change.range.pos);
    const kind = change.tracking.type as TrackedChangeKind;
    return {
      id: `change-${kind}-${position}`,
      kind,
      position,
      text: content.slice(change.range.pos, change.range.pos + change.range.length),
      userId: typeof change.tracking.userId === 'string' ? change.tracking.userId : null,
      timestamp: normalizeTimestamp(change.tracking.ts)
    };
  });

  return { changes, visibleContent };
}

export class RejectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectConflictError';
  }
}

function quote(text: string, max = 60): string {
  const shown = text.length > max ? `${text.slice(0, max)}...` : text;
  return JSON.stringify(shown);
}

/**
 * Build the ops that reject `changes` in a sharejs-text-ot doc whose visible
 * text is `content`: a tracked insertion is removed, a tracked deletion is
 * put back. Returns the ops in the order they must be sent and the text they
 * produce.
 *
 * `changes` must be in the ranges tracker's order (a filter of
 * `parseShareJsChanges` output keeps it).
 *
 * The ops are applied one after another, each to the result of the previous
 * one, so they run from the highest position to the lowest: undoing a change
 * then never moves a change that has yet to be undone. That is the ordering
 * the Overleaf editor uses, and its own comment explains the failure it
 * prevents. A word replaced as "foo bar baz" -> "foo quux baz" is a tracked
 * insertion of "quux" at 4 and a tracked deletion of "bar" at 8. Removing
 * "quux" first and then restoring "bar" at 8 gives "foo  bazbar"; restoring
 * "bar" first gives "foo quuxbar baz", and removing "quux" then gives
 * "foo bar baz".
 *
 * Changes at the same position run in reverse tracker order. The tracker
 * keeps a deletion ahead of an insertion at the same offset, so the
 * insertion is removed before the deleted text is put back in front of
 * where it was, and several deletions at one offset are restored last one
 * first, which leaves them in their original order.
 *
 * Every step is checked against the text it applies to, exactly as the
 * server checks a delete op. A change that no longer matches throws
 * `RejectConflictError` and nothing is returned, so a stale or overlapping
 * selection fails here instead of on the server or, worse, removing the
 * wrong text.
 */
export function planRejection(content: string, changes: DocTrackedChange[]): { ops: ShareJsTextOp[]; content: string } {
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => b.change.position - a.change.position || b.index - a.index);

  let text = content;
  const ops: ShareJsTextOp[] = [];
  for (const { change } of ordered) {
    const { position } = change;
    if (position < 0 || position > text.length) {
      throw new RejectConflictError(`Tracked change ${change.id} points at position ${position}, outside the document (length ${text.length})`);
    }
    if (change.kind === 'insert') {
      const found = text.slice(position, position + change.text.length);
      if (found !== change.text) {
        throw new RejectConflictError(
          `Tracked change ${change.id} no longer matches the document: expected ${quote(change.text)} at position ${position}, found ${quote(found)}. If it overlaps another selected change, reject them one at a time`
        );
      }
      ops.push({ p: position, d: change.text, u: true });
      text = text.slice(0, position) + text.slice(position + change.text.length);
    } else {
      ops.push({ p: position, i: change.text, u: true });
      text = text.slice(0, position) + change.text + text.slice(position);
    }
  }

  return { ops, content: text };
}

/**
 * Apply ShareJS text ops the way the server's text type does, one component
 * after another, refusing a delete whose text does not match.
 */
export function applyTextOps(content: string, ops: ShareJsTextOp[]): string {
  let text = content;
  for (const op of ops) {
    if (typeof op.i === 'string') {
      text = text.slice(0, op.p) + op.i + text.slice(op.p);
    } else if (typeof op.d === 'string') {
      const deleted = text.slice(op.p, op.p + op.d.length);
      if (deleted !== op.d) {
        throw new Error(`Delete component '${op.d}' does not match deleted text '${deleted}'`);
      }
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
    } else {
      throw new Error('Unknown op type');
    }
  }
  return text;
}

/**
 * Map user ids to people. Project owner and members come from the project
 * itself; `changesUsers` (GET /project/<id>/changes/users) adds people who
 * made changes but are no longer members. Members win on conflict, the same
 * precedence the Overleaf editor uses.
 */
export function buildUserDirectory(project: any, changesUsers: unknown[] = []): Map<string, ReviewUser> {
  const users = new Map<string, ReviewUser>();
  const add = (user: any, id: unknown): void => {
    if (typeof id !== 'string' || !id) return;
    users.set(id, {
      id,
      email: typeof user?.email === 'string' ? user.email : undefined,
      first_name: typeof user?.first_name === 'string' ? user.first_name : undefined,
      last_name: typeof user?.last_name === 'string' ? user.last_name : undefined
    });
  };
  for (const user of changesUsers as any[]) add(user, user?.id ?? user?._id);
  if (project?.owner) add(project.owner, project.owner._id ?? project.owner.id);
  for (const member of project?.members ?? []) add(member, member?._id ?? member?.id);
  return users;
}

export function describeAuthor(userId: string | null, users: Map<string, ReviewUser>): TrackedChangeAuthor {
  if (!userId) return { id: null };
  const user = users.get(userId);
  if (!user) return { id: userId };
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return {
    id: userId,
    ...(name ? { name } : {}),
    ...(user.email ? { email: user.email } : {})
  };
}

export function formatAuthor(author: TrackedChangeAuthor): string {
  if (author.name && author.email) return `${author.name} <${author.email}>`;
  return author.name || author.email || author.id || 'unknown user';
}

/** Unified diff of a doc before and after a rejection, for the preview. */
export function renderRejectionDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, { context: 2 });
}
