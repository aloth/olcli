import { OlcliError } from '../errors/olcli-error.js';
import type { JoinedDocument, OverleafOtType } from './types.js';

function decodeOverleafUtf8(text: string): string {
  return Buffer.from(text, 'binary').toString('utf-8');
}

export function normalizeOverleafOtType(type: unknown): OverleafOtType {
  if (type === 'sharejs-text-ot' || type === 'history-ot') return type;
  return `unknown:${String(type)}`;
}

export function normalizeJoinedDocument(docId: string, args: unknown[]): JoinedDocument {
  const [rawLines, rawVersion, _updates, rawRanges, rawType = 'sharejs-text-ot'] = args;
  if (!Number.isSafeInteger(rawVersion) || (rawVersion as number) < 0) {
    throw new OlcliError('PROTOCOL_ERROR', 'joinDoc returned an invalid document version', {
      details: { docId },
    });
  }

  const version = rawVersion as number;
  const type = normalizeOverleafOtType(rawType);

  if (type === 'history-ot') {
    const historySnapshot = rawLines && typeof rawLines === 'object'
      ? rawLines as Record<string, unknown>
      : {};
    const content = typeof historySnapshot.content === 'string' ? historySnapshot.content : '';
    return {
      docId,
      lines: content.split('\n'),
      content,
      version,
      ranges: historySnapshot,
      type,
    };
  }

  const lines = Array.isArray(rawLines)
    ? rawLines.map(line => typeof line === 'string' ? decodeOverleafUtf8(line) : '')
    : [];
  const rangeRecord = rawRanges && typeof rawRanges === 'object'
    ? rawRanges as Record<string, unknown>
    : {};
  const comments = Array.isArray(rangeRecord.comments)
    ? rangeRecord.comments.map(rawComment => {
        if (!rawComment || typeof rawComment !== 'object') return rawComment;
        const comment = { ...rawComment as Record<string, unknown> };
        if (comment.op && typeof comment.op === 'object') {
          const op = { ...comment.op as Record<string, unknown> };
          if (typeof op.c === 'string') op.c = decodeOverleafUtf8(op.c);
          comment.op = op;
        }
        return comment;
      })
    : [];

  return {
    docId,
    lines,
    content: lines.join('\n'),
    version,
    ranges: { ...rangeRecord, comments },
    type,
  };
}
