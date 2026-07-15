import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  normalizeHistoryDocDiffResponse,
  normalizeHistoryEntry,
  normalizeHistoryFileTreeResponse,
} from '../../src/history/service.js';

const fixtureDirectory = join(process.cwd(), 'test/fixtures/protocol');

function fixture(name: string): { metadata: { sanitized: boolean }; response: unknown } {
  return JSON.parse(readFileSync(join(fixtureDirectory, name), 'utf8'));
}

describe('sanitized history protocol fixtures', () => {
  it('normalizes update groups without exposing author email addresses', () => {
    const data = fixture('history-updates.json');
    const response = data.response as { updates: unknown[] };
    const entries = response.updates.map(normalizeHistoryEntry);

    expect(data.metadata.sanitized).toBe(true);
    expect(entries).toMatchObject([
      {
        id: '8:10',
        authors: [{ id: 'user-1', name: 'Synthetic Author' }],
        origin: { kind: 'upload' },
        pathnames: ['main.tex'],
      },
      {
        id: '7:8',
        authors: [{ name: 'Anonymous' }],
        external: true,
        projectOperations: [{
          kind: 'rename',
          atVersion: 8,
          path: 'old.tex',
          newPath: 'renamed.tex',
        }],
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('@example.invalid');
    expect(normalizeHistoryEntry({
      ...(response.updates[0] as Record<string, unknown>),
      meta: {
        users: [{ email: 'email-only@example.invalid' }],
        start_ts: 1783900800000,
        end_ts: 1783900805000,
      },
    }).authors).toEqual([{ name: 'Unknown' }]);
  });

  it('normalizes file-tree operations and text diff chunks', () => {
    const files = normalizeHistoryFileTreeResponse(
      fixture('history-filetree-diff.json').response
    );
    const diff = normalizeHistoryDocDiffResponse(
      fixture('history-doc-diff.json').response
    );

    expect(files).toContainEqual({
      path: 'removed.bin',
      operation: 'removed',
      editable: false,
      deletedAtVersion: 9,
    });
    expect(diff).toMatchObject({
      binary: false,
      insertedCharacters: 3,
      deletedCharacters: 3,
      unchangedCharacters: 14,
      chunks: [
        { kind: 'delete', offset: 7, length: 3, text: 'old' },
        { kind: 'insert', offset: 10, length: 3, text: 'new' },
      ],
    });
    expect(JSON.stringify(diff)).not.toContain('@example.invalid');
  });
});
