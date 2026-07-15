import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HistoryService } from '../../src/history/service.js';
import type { HistoryServiceHost } from '../../src/history/types.js';

const fixtureDirectory = join(process.cwd(), 'test/fixtures/protocol');

function fixtureResponse(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDirectory, name), 'utf8')).response;
}

function update(fromV: number, toV: number) {
  return {
    fromV,
    toV,
    meta: {
      users: [],
      start_ts: 1783900000000 + fromV,
      end_ts: 1783900000000 + toV,
    },
    labels: [],
    pathnames: ['main.tex'],
    project_ops: [],
  };
}

class FakeHistoryHost implements HistoryServiceHost {
  calls: string[] = [];
  constructor(private readonly respond: (path: string) => unknown) {}

  async getHistoryJson(path: string): Promise<unknown> {
    this.calls.push(path);
    return this.respond(path);
  }
}

describe('HistoryService', () => {
  it('follows server cursors, enforces a client limit, and returns a resumable boundary', async () => {
    const host = new FakeHistoryHost(path => {
      const url = new URL(path, 'https://example.invalid');
      if (url.searchParams.get('before') === '7') {
        return { updates: [update(5, 7), update(4, 5)] };
      }
      return { updates: [update(8, 10), update(7, 8)], nextBeforeTimestamp: 7 };
    });

    const result = await new HistoryService(host).listHistory('project-1', {
      limit: 3,
      minCount: 2,
    });

    expect(result.entries.map(entry => entry.id)).toEqual(['8:10', '7:8', '5:7']);
    expect(result).toMatchObject({ nextBefore: 5, atEnd: false });
    expect(host.calls).toEqual([
      '/project/project-1/updates?min_count=2',
      '/project/project-1/updates?min_count=2&before=7',
    ]);
  });

  it('handles min_count over-return without losing a pagination boundary', async () => {
    const host = new FakeHistoryHost(() => ({
      updates: [update(8, 10), update(7, 8)],
    }));
    const result = await new HistoryService(host).listHistory('project-1', { limit: 1 });

    expect(result.entries.map(entry => entry.id)).toEqual(['8:10']);
    expect(result).toMatchObject({ nextBefore: 8, atEnd: false });
  });

  it('normalizes one text file diff while excluding unchanged content by default', async () => {
    const host = new FakeHistoryHost(path => (
      path.includes('/filetree/diff?')
        ? fixtureResponse('history-filetree-diff.json')
        : fixtureResponse('history-doc-diff.json')
    ));

    const result = await new HistoryService(host).diffFile(
      'project-1',
      'main.tex',
      8,
      10
    );

    expect(result).toMatchObject({
      path: 'main.tex',
      fromVersion: 8,
      toVersion: 10,
      file: { operation: 'edited' },
      binary: false,
      stats: {
        insertedCharacters: 3,
        deletedCharacters: 3,
        unchangedCharacters: 14,
      },
    });
    expect(result.chunks.map(chunk => [chunk.kind, chunk.text])).toEqual([
      ['delete', 'old'],
      ['insert', 'new'],
    ]);
  });

  it('supports metadata-only diffs and old-path lookup for renames', async () => {
    const host = new FakeHistoryHost(path => (
      path.includes('/filetree/diff?')
        ? fixtureResponse('history-filetree-diff.json')
        : fixtureResponse('history-doc-diff.json')
    ));
    const result = await new HistoryService(host).diffFile(
      'project-1',
      'old.tex',
      7,
      8,
      { includeContent: false, includeUnchanged: true }
    );

    expect(result.file).toMatchObject({
      operation: 'renamed',
      oldPath: 'old.tex',
      newPath: 'renamed.tex',
    });
    expect(result.chunks).toHaveLength(4);
    expect(result.chunks.every(chunk => chunk.text === undefined)).toBe(true);
    expect(host.calls[1]).toContain('pathname=renamed.tex');
  });

  it('reports binary history without inventing text chunks', async () => {
    const host = new FakeHistoryHost(path => (
      path.includes('/filetree/diff?')
        ? fixtureResponse('history-filetree-diff.json')
        : { diff: { binary: true } }
    ));
    const result = await new HistoryService(host).diffFile(
      'project-1',
      'removed.bin',
      8,
      10
    );

    expect(result).toMatchObject({ binary: true, chunks: [] });
  });

  it('fails before transport for invalid version ranges', async () => {
    const host = new FakeHistoryHost(() => { throw new Error('should not run'); });

    await expect(new HistoryService(host).diffFile(
      'project-1',
      'main.tex',
      10,
      10
    )).rejects.toMatchObject({ code: 'HISTORY_VERSION_INVALID' });
    expect(host.calls).toEqual([]);
  });

  it('fails closed for malformed history responses and missing files', async () => {
    const invalidHost = new FakeHistoryHost(() => ({ updates: [{ fromV: 'bad' }] }));
    await expect(new HistoryService(invalidHost).listHistory('project-1'))
      .rejects.toMatchObject({ code: 'HISTORY_RESPONSE_INVALID' });

    const missingHost = new FakeHistoryHost(() => ({
      diff: [{ pathname: 'other.tex', editable: true }],
    }));
    await expect(new HistoryService(missingHost).diffFile(
      'project-1',
      'main.tex',
      1,
      2
    )).rejects.toMatchObject({ code: 'HISTORY_FILE_NOT_FOUND' });
    expect(missingHost.calls).toHaveLength(1);
  });
});
