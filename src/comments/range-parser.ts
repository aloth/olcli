import type { CommentContext, CommentMessage, ProjectComment } from '../client.js';
import type { JoinedDocument } from '../realtime/types.js';

export interface ProjectDocumentRef {
  id: string;
  path: string;
}

export type CommentThreads = Record<
  string,
  { messages: CommentMessage[]; resolved?: boolean }
>;

export function positionToLineColumn(content: string, position: number): { line: number; column: number } {
  const prefix = content.slice(0, Math.max(0, position));
  const lines = prefix.split('\n');
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

export function buildCommentContext(
  content: string,
  line: number,
  contextLines = 0
): CommentContext | undefined {
  if (contextLines <= 0) return undefined;

  const lines = content.split('\n');
  const lineIndex = line - 1;
  const beforeStart = Math.max(0, lineIndex - contextLines);
  const afterEnd = Math.min(lines.length, lineIndex + contextLines + 1);

  return {
    startLine: beforeStart + 1,
    endLine: afterEnd,
    before: lines.slice(beforeStart, lineIndex),
    line: lines[lineIndex] || '',
    after: lines.slice(lineIndex + 1, afterEnd),
  };
}

/** Normalize comment ranges from either supported document representation. */
export function parseDocumentComments(
  document: JoinedDocument,
  doc: ProjectDocumentRef,
  threads: CommentThreads,
  contextLines = 0
): ProjectComment[] {
  const comments: ProjectComment[] = [];
  const rawComments = Array.isArray(document.ranges?.comments)
    ? document.ranges.comments
    : [];

  if (document.type === 'history-ot') {
    for (const comment of rawComments) {
      const ranges: unknown[] = Array.isArray(comment?.ranges) ? comment.ranges : [];
      const validRanges = ranges.filter(
        (range: unknown): range is { pos: number; length: number } =>
          typeof (range as { pos?: unknown })?.pos === 'number'
          && typeof (range as { length?: unknown })?.length === 'number'
      );
      const firstRange = validRanges[0];
      if (!firstRange || typeof comment?.id !== 'string') continue;

      const selectedText = validRanges
        .map(range => document.content.slice(range.pos, range.pos + range.length))
        .join('');
      const location = positionToLineColumn(document.content, firstRange.pos);
      const thread = threads[comment.id] || { messages: [] };
      const resolved = Boolean(comment.resolved || thread.resolved);
      comments.push({
        threadId: comment.id,
        docId: doc.id,
        path: doc.path,
        position: firstRange.pos,
        line: location.line,
        column: location.column,
        selectedText,
        resolved,
        messages: thread.messages || [],
        context: buildCommentContext(document.content, location.line, contextLines),
      });
    }
    return comments;
  }

  for (const comment of rawComments) {
    const op = comment?.op || {};
    const threadId = op.t || comment?.id;
    if (typeof threadId !== 'string' || typeof op.p !== 'number') continue;

    const selectedText = typeof op.c === 'string'
      ? op.c
      : document.content.slice(op.p, op.p + (op.c?.length || 0));
    const location = positionToLineColumn(document.content, op.p);
    const thread = threads[threadId] || { messages: [] };
    const resolved = Boolean(comment.resolved || op.resolved || thread.resolved);
    comments.push({
      threadId,
      docId: doc.id,
      path: doc.path,
      position: op.p,
      line: location.line,
      column: location.column,
      selectedText,
      resolved,
      messages: thread.messages || [],
      context: buildCommentContext(document.content, location.line, contextLines),
    });
  }

  return comments;
}
