import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OlcliError } from '../../src/errors/olcli-error.js';
import { loadIgnore, shouldIgnore } from '../../src/ignore.js';
import { ReviewLedgerStore } from '../../src/review/ledger.js';
import type { ReviewLedgerEntry } from '../../src/review/types.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'olcli-review-ledger-'));
  directories.push(directory);
  return directory;
}

function entry(): ReviewLedgerEntry {
  return {
    operationId: '123e4567-e89b-42d3-a456-426614174000',
    threadId: 'thread-1',
    docId: 'doc-1',
    path: 'main.tex',
    sourceVersion: 7,
    sourceSha256: 'a'.repeat(64),
    expectedResultSha256: 'b'.repeat(64),
    requestSha256: 'c'.repeat(64),
    changeIds: ['change-1'],
    gitCommit: 'd'.repeat(40),
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    state: 'suggested',
    resolutionPolicy: 'never',
    replySha256: 'e'.repeat(64),
    replyStatus: 'posted',
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('ReviewLedgerStore', () => {
  it('writes a versioned ledger atomically with private file permissions', async () => {
    const directory = await temporaryDirectory();
    const store = new ReviewLedgerStore(undefined, directory);

    await store.update('project-1', ledger => ledger.entries.push(entry()));

    const ledger = await store.read('project-1');
    expect(ledger).toEqual({ schemaVersion: 1, projectId: 'project-1', entries: [entry()] });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('backs up corrupt data and refuses to overwrite it', async () => {
    const directory = await temporaryDirectory();
    const store = new ReviewLedgerStore(undefined, directory);
    await writeFile(store.path, '{ definitely not json', 'utf8');

    const error = await store.read('project-1').catch(value => value);
    expect(error).toBeInstanceOf(OlcliError);
    expect(error).toMatchObject({ code: 'LEDGER_CORRUPT' });
    expect(await readFile(store.path, 'utf8')).toBe('{ definitely not json');
    expect((await readdir(directory)).some(name => name.includes('.corrupt-'))).toBe(true);
  });

  it('refuses to reuse a ledger for another project', async () => {
    const directory = await temporaryDirectory();
    const store = new ReviewLedgerStore(undefined, directory);
    await store.write({ schemaVersion: 1, projectId: 'project-1', entries: [] });

    await expect(store.read('project-2')).rejects.toMatchObject({
      code: 'LEDGER_PROJECT_MISMATCH',
    });
  });

  it('fails closed instead of losing concurrent process updates', async () => {
    const directory = await temporaryDirectory();
    const store = new ReviewLedgerStore(undefined, directory);
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });

    const first = store.update('project-1', async ledger => {
      markStarted();
      await gate;
      ledger.entries.push(entry());
    });
    await started;

    await expect(store.update('project-1', () => undefined)).rejects.toMatchObject({
      code: 'REVIEW_OPERATION_CONFLICT',
    });
    releaseFirst();
    await first;
    expect((await store.read('project-1')).entries).toHaveLength(1);
  });

  it('excludes ledger, temporary, and corrupt-backup files from sync', async () => {
    const directory = await temporaryDirectory();
    const ignore = loadIgnore(directory);

    expect(shouldIgnore('.olcli-review.json', ignore)).toBe(true);
    expect(shouldIgnore('.olcli-review.json.tmp-123', ignore)).toBe(true);
    expect(shouldIgnore('.olcli-review.json.corrupt-2026', ignore)).toBe(true);
  });
});
