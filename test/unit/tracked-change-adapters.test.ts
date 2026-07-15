import { describe, expect, it } from 'vitest';

import { getTrackedChangesAdapter } from '../../src/changes/adapters.js';
import { historyEditorToSnapshotPosition } from '../../src/changes/history-offsets.js';
import type { JoinedDocument } from '../../src/realtime/types.js';

describe('tracked-change adapters', () => {
  it('normalizes legacy ShareJS insertions and deletions', () => {
    const document: JoinedDocument = {
      docId: 'doc-legacy',
      content: 'first\ninserted text',
      lines: ['first', 'inserted text'],
      version: 4,
      type: 'sharejs-text-ot',
      ranges: {
        changes: [
          {
            id: 'change-insert',
            op: { p: 6, i: 'inserted ' },
            metadata: { user_id: 'user-1', ts: '2026-07-13T00:00:00.000Z' },
          },
          {
            id: 'change-delete',
            op: { p: 19, d: 'old' },
            metadata: { user_id: 'user-2', ts: 1_783_910_400_000 },
          },
        ],
      },
    };

    const changes = getTrackedChangesAdapter(document.type).listChanges(
      document,
      'main.tex',
      { contextLines: 1 }
    );

    expect(changes).toEqual([
      expect.objectContaining({
        id: 'change-insert',
        kind: 'insert',
        position: 6,
        line: 2,
        column: 1,
        text: 'inserted ',
        authorId: 'user-1',
        raw: undefined,
      }),
      expect.objectContaining({
        id: 'change-delete',
        kind: 'delete',
        position: 19,
        line: 2,
        column: 14,
        text: 'old',
        timestamp: '2026-07-13T02:40:00.000Z',
      }),
    ]);
    expect(changes[0].context).toEqual({
      startLine: 1,
      endLine: 2,
      before: ['first'],
      line: 'inserted text',
      after: [],
    });
  });

  it('maps history-OT snapshot offsets around tracked deletions', () => {
    const document: JoinedDocument = {
      docId: 'doc-history',
      // The editor displays "new text\nλ" because "old " is a tracked deletion.
      content: 'old new text\nλ',
      lines: ['old new text', 'λ'],
      version: 9,
      type: 'history-ot',
      ranges: {
        content: 'old new text\nλ',
        trackedChanges: [
          {
            range: { pos: 0, length: 4 },
            tracking: { type: 'delete', userId: 'user-delete', ts: 'delete-ts' },
          },
          {
            range: { pos: 4, length: 3 },
            tracking: { type: 'insert', userId: 'user-insert', ts: 'insert-ts' },
          },
        ],
      },
    };

    const changes = getTrackedChangesAdapter(document.type).listChanges(
      document,
      'unicode.tex',
      { contextLines: 1, includeRaw: true }
    );

    expect(changes).toEqual([
      expect.objectContaining({
        id: 'change-delete-0',
        kind: 'delete',
        position: 0,
        snapshotPosition: 0,
        text: 'old ',
        line: 1,
        column: 1,
        authorId: 'user-delete',
        raw: expect.any(Object),
      }),
      expect.objectContaining({
        id: 'change-insert-0',
        kind: 'insert',
        position: 0,
        snapshotPosition: 4,
        text: 'new',
        line: 1,
        column: 1,
        authorId: 'user-insert',
      }),
    ]);
    expect(changes[1].context?.line).toBe('new text');
    expect(historyEditorToSnapshotPosition(0, document.ranges.trackedChanges as any)).toBe(0);
    expect(historyEditorToSnapshotPosition(1, document.ranges.trackedChanges as any)).toBe(5);
  });

  it('builds protocol-specific tracked replacements', () => {
    const historyDocument: JoinedDocument = {
      docId: 'doc-history',
      content: 'alpha old omega',
      lines: ['alpha old omega'],
      version: 3,
      type: 'history-ot',
      ranges: { content: 'alpha old omega', trackedChanges: [] },
    };
    const mutation = getTrackedChangesAdapter('history-ot').buildTrackedReplacement(
      historyDocument,
      6,
      'old',
      'new',
      {
        trackChangeSeed: 'unused-seed',
        currentUserId: 'user-1',
        timestamp: new Date('2026-07-13T00:00:00.000Z'),
      }
    );

    expect(mutation).toEqual({
      operations: [{
        textOperation: [
          6,
          {
            i: 'new',
            tracking: {
              type: 'insert',
              userId: 'user-1',
              ts: '2026-07-13T00:00:00.000Z',
            },
          },
          {
            r: 3,
            tracking: {
              type: 'delete',
              userId: 'user-1',
              ts: '2026-07-13T00:00:00.000Z',
            },
          },
          6,
        ],
      }],
      normalizedOperations: [
        { kind: 'insert', position: 6, text: 'new' },
        { kind: 'delete', position: 9, text: 'old' },
      ],
      metadata: {},
    });
  });

  it('builds accept and reject operations for both OT formats', () => {
    const historyDocument: JoinedDocument = {
      docId: 'doc-history',
      content: 'alpha newold omega',
      lines: ['alpha newold omega'],
      version: 4,
      type: 'history-ot',
      ranges: {},
    };
    const historyChanges = [
      {
        id: 'change-insert-6',
        docId: 'doc-history',
        path: 'main.tex',
        otType: 'history-ot' as const,
        kind: 'insert' as const,
        position: 6,
        snapshotPosition: 6,
        line: 1,
        column: 7,
        text: 'new',
      },
      {
        id: 'change-delete-9',
        docId: 'doc-history',
        path: 'main.tex',
        otType: 'history-ot' as const,
        kind: 'delete' as const,
        position: 9,
        snapshotPosition: 9,
        line: 1,
        column: 10,
        text: 'old',
      },
    ];

    expect(getTrackedChangesAdapter('history-ot').buildTrackedResolution(
      historyDocument,
      historyChanges,
      'accept'
    )).toEqual({
      transport: 'ot',
      operations: [{ textOperation: [
        6,
        { r: 3, tracking: { type: 'none' } },
        -3,
        6,
      ] }],
    });
    expect(getTrackedChangesAdapter('history-ot').buildTrackedResolution(
      historyDocument,
      historyChanges,
      'reject'
    )).toEqual({
      transport: 'ot',
      operations: [{ textOperation: [
        6,
        -3,
        { r: 3, tracking: { type: 'none' } },
        6,
      ] }],
    });

    expect(getTrackedChangesAdapter('sharejs-text-ot').buildTrackedResolution(
      { ...historyDocument, type: 'sharejs-text-ot' },
      historyChanges.map(change => ({ ...change, otType: 'sharejs-text-ot' as const })),
      'reject'
    )).toEqual({
      transport: 'ot',
      operations: [
        { p: 9, i: 'old', u: true },
        { p: 6, d: 'new', u: true },
      ],
    });
  });

  it('handles insert-only, delete-only, and BMP Unicode history suggestions', () => {
    const adapter = getTrackedChangesAdapter('history-ot');
    const options = {
      trackChangeSeed: 'unused',
      currentUserId: 'user-1',
      timestamp: new Date('2026-07-13T00:00:00.000Z'),
    };
    const base: JoinedDocument = {
      docId: 'doc-history',
      content: 'abc',
      lines: ['abc'],
      version: 1,
      type: 'history-ot',
      ranges: {},
    };

    expect(adapter.buildTrackedReplacement(base, 1, '', 'x', options).operations)
      .toEqual([{ textOperation: [
        1,
        {
          i: 'x',
          tracking: {
            type: 'insert',
            userId: 'user-1',
            ts: '2026-07-13T00:00:00.000Z',
          },
        },
        2,
      ] }]);
    expect(adapter.buildTrackedReplacement(base, 1, 'b', '', options).operations)
      .toEqual([{ textOperation: [
        1,
        {
          r: 1,
          tracking: {
            type: 'delete',
            userId: 'user-1',
            ts: '2026-07-13T00:00:00.000Z',
          },
        },
        1,
      ] }]);

    const unicode = { ...base, content: 'aλb', lines: ['aλb'] };
    expect(adapter.buildTrackedReplacement(unicode, 1, 'λ', 'β', options).operations)
      .toEqual([{ textOperation: [
        1,
        {
          i: 'β',
          tracking: {
            type: 'insert',
            userId: 'user-1',
            ts: '2026-07-13T00:00:00.000Z',
          },
        },
        {
          r: 1,
          tracking: {
            type: 'delete',
            userId: 'user-1',
            ts: '2026-07-13T00:00:00.000Z',
          },
        },
        1,
      ] }]);
  });

  it.each([
    ['accept', 0, [6, { r: 3, tracking: { type: 'none' } }, 9]],
    ['accept', 1, [9, -3, 6]],
    ['reject', 0, [6, -3, 9]],
    ['reject', 1, [9, { r: 3, tracking: { type: 'none' } }, 6]],
  ] as const)('%s resolves one history change at index %s', (action, index, textOperation) => {
    const document: JoinedDocument = {
      docId: 'doc-history',
      content: 'alpha newold omega',
      lines: ['alpha newold omega'],
      version: 4,
      type: 'history-ot',
      ranges: {},
    };
    const changes = [
      {
        id: 'change-insert-6', docId: 'doc-history', path: 'main.tex',
        otType: 'history-ot' as const, kind: 'insert' as const,
        position: 6, snapshotPosition: 6, line: 1, column: 7, text: 'new',
      },
      {
        id: 'change-delete-9', docId: 'doc-history', path: 'main.tex',
        otType: 'history-ot' as const, kind: 'delete' as const,
        position: 9, snapshotPosition: 9, line: 1, column: 10, text: 'old',
      },
    ];
    expect(getTrackedChangesAdapter('history-ot').buildTrackedResolution(
      document,
      [changes[index]],
      action
    )).toEqual({ transport: 'ot', operations: [{ textOperation }] });
  });

  it('fails closed for non-BMP history-OT insertions', () => {
    const document: JoinedDocument = {
      docId: 'doc-history',
      content: 'abc',
      lines: ['abc'],
      version: 1,
      type: 'history-ot',
      ranges: {},
    };
    expect(() => getTrackedChangesAdapter('history-ot').buildTrackedReplacement(
      document,
      1,
      '',
      '😀',
      {
        trackChangeSeed: 'unused',
        currentUserId: 'user-1',
        timestamp: new Date(),
      }
    )).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_OT_TYPE' }));
  });

  it('fails closed for unknown OT types', () => {
    const adapter = getTrackedChangesAdapter('unknown:future-ot');
    expect(() => adapter.listChanges({} as JoinedDocument, 'main.tex'))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_OT_TYPE' }));
  });
});
