import { describe, expect, it } from 'vitest';

import {
  buildCommentContext,
  parseDocumentComments,
  positionToLineColumn,
} from '../../src/comments/range-parser.js';
import type { JoinedDocument } from '../../src/realtime/types.js';

describe('comment range parsing', () => {
  it('normalizes legacy ShareJS comment operations', () => {
    const document: JoinedDocument = {
      docId: 'doc-1',
      lines: ['first', 'selected text', 'last'],
      content: 'first\nselected text\nlast',
      version: 3,
      type: 'sharejs-text-ot',
      ranges: {
        comments: [{ op: { p: 6, c: 'selected', t: 'thread-1' } }],
      },
    };

    const result = parseDocumentComments(
      document,
      { id: 'doc-1', path: 'main.tex' },
      { 'thread-1': { messages: [{ id: 'message-1', content: 'Please revise.' }] } },
      1
    );

    expect(result).toEqual([expect.objectContaining({
      threadId: 'thread-1',
      path: 'main.tex',
      position: 6,
      line: 2,
      column: 1,
      selectedText: 'selected',
      resolved: false,
      context: {
        startLine: 1,
        endLine: 3,
        before: ['first'],
        line: 'selected text',
        after: ['last'],
      },
    })]);
  });

  it('normalizes history-OT ranges and thread resolution state', () => {
    const document: JoinedDocument = {
      docId: 'doc-2',
      lines: ['alpha beta gamma'],
      content: 'alpha beta gamma',
      version: 8,
      type: 'history-ot',
      ranges: {
        comments: [{
          id: 'thread-2',
          ranges: [{ pos: 0, length: 5 }, { pos: 11, length: 5 }],
        }],
      },
    };

    expect(parseDocumentComments(
      document,
      { id: 'doc-2', path: 'chapter.tex' },
      { 'thread-2': { messages: [], resolved: true } }
    )).toEqual([expect.objectContaining({
      threadId: 'thread-2',
      selectedText: 'alphagamma',
      resolved: true,
      line: 1,
      column: 1,
    })]);
  });

  it('skips malformed ranges and maps positions consistently', () => {
    const document: JoinedDocument = {
      docId: 'doc-3',
      lines: ['one', 'two'],
      content: 'one\ntwo',
      version: 1,
      type: 'history-ot',
      ranges: { comments: [{ id: 'bad', ranges: [{ pos: '0', length: 1 }] }] },
    };

    expect(parseDocumentComments(document, { id: 'doc-3', path: 'x.tex' }, {})).toEqual([]);
    expect(positionToLineColumn(document.content, 4)).toEqual({ line: 2, column: 1 });
    expect(buildCommentContext(document.content, 2, 0)).toBeUndefined();
  });
});
