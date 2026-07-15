import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Text } from '../../src/changes/matcher.js';
import type {
  SuggestionPreview,
  SuggestionResult,
  TrackedDocumentInspection,
} from '../../src/changes/types.js';
import type { ProjectComment } from '../../src/client.js';
import { ReviewLedgerStore } from '../../src/review/ledger.js';
import { ReviewService } from '../../src/review/service.js';
import type { ReviewServiceHost } from '../../src/review/types.js';

const directories: string[] = [];
const operationId = '123e4567-e89b-42d3-a456-426614174000';
const source = 'alpha SECRET_OLD_PASSAGE omega';
const revised = 'alpha SECRET_NEW_PASSAGE omega';

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'olcli-review-service-'));
  directories.push(directory);
  return directory;
}

class FakeReviewHost implements ReviewServiceHost {
  comment: ProjectComment = {
    threadId: 'thread-1',
    docId: 'doc-1',
    path: 'main.tex',
    position: 6,
    line: 1,
    column: 7,
    selectedText: 'SECRET_OLD_PASSAGE',
    resolved: false,
    messages: [],
  };
  activeChangeIds = ['insert-1', 'delete-1'];
  documentSha256 = sha256Text(revised);
  suggestionCalls = 0;
  replyCalls = 0;
  resolveCalls = 0;
  failReplyOnce = false;

  preview(): SuggestionPreview {
    return {
      projectId: 'project-1',
      docId: 'doc-1',
      path: 'main.tex',
      otType: 'sharejs-text-ot',
      version: 7,
      textSha256: sha256Text(source),
      position: 6,
      line: 1,
      column: 7,
      oldText: 'SECRET_OLD_PASSAGE',
      newText: 'SECRET_NEW_PASSAGE',
      operations: [
        { kind: 'insert', position: 6, text: 'SECRET_NEW_PASSAGE' },
        { kind: 'delete', position: 24, text: 'SECRET_OLD_PASSAGE' },
      ],
      expectedResultSha256: sha256Text(revised),
    };
  }

  async getComment(): Promise<ProjectComment> {
    return {
      ...this.comment,
      messages: this.comment.messages.map(message => ({ ...message })),
    };
  }

  async previewTrackedSuggestion(): Promise<SuggestionPreview> {
    return this.preview();
  }

  async suggestTrackedChange(): Promise<SuggestionResult> {
    this.suggestionCalls += 1;
    return {
      ...this.preview(),
      beforeVersion: 7,
      afterVersion: 8,
      changeIds: ['insert-1', 'delete-1'],
      verified: true,
      trackChangesStateRestored: true,
    };
  }

  async listTrackedChanges(): Promise<Array<{ id: string }>> {
    return this.activeChangeIds.map(id => ({ id }));
  }

  async inspectTrackedDocument(): Promise<TrackedDocumentInspection> {
    return {
      projectId: 'project-1',
      docId: 'doc-1',
      path: 'main.tex',
      otType: 'sharejs-text-ot',
      version: 8,
      textSha256: this.documentSha256,
    };
  }

  async postCommentMessage(_projectId: string, _threadId: string, content: string): Promise<void> {
    if (this.failReplyOnce) {
      this.failReplyOnce = false;
      throw new Error('synthetic reply failure');
    }
    this.replyCalls += 1;
    this.comment.messages.push({ id: `message-${this.replyCalls}`, content });
  }

  async resolveComment(): Promise<ProjectComment> {
    this.resolveCalls += 1;
    this.comment.resolved = true;
    return this.comment;
  }
}

async function fixture(): Promise<{
  directory: string;
  store: ReviewLedgerStore;
  host: FakeReviewHost;
  service: ReviewService;
}> {
  const directory = await temporaryDirectory();
  const store = new ReviewLedgerStore(undefined, directory);
  const host = new FakeReviewHost();
  const service = new ReviewService(host, {
    ledgerStore: store,
    workingDirectory: directory,
    now: () => new Date('2026-07-13T00:00:00.000Z'),
    operationId: () => operationId,
    gitCommitResolver: async () => 'a'.repeat(40),
  });
  return { directory, store, host, service };
}

function addressInput(resolutionPolicy: 'never' | 'after-suggest' | 'after-accept' = 'never') {
  return {
    projectId: 'project-1',
    threadId: 'thread-1',
    filePath: 'main.tex',
    oldText: 'SECRET_OLD_PASSAGE',
    newText: 'SECRET_NEW_PASSAGE',
    reply: 'SECRET_REPLY_BODY',
    resolutionPolicy,
    operationId,
  } as const;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('ReviewService', () => {
  it('creates a suggestion, replies, and stores no source or reply body', async () => {
    const { store, host, service } = await fixture();
    const outcome = await service.addressComment(addressInput());

    expect(outcome).toMatchObject({
      operationId,
      resumed: false,
      entry: {
        state: 'suggested',
        changeIds: ['insert-1', 'delete-1'],
        replyStatus: 'posted',
        resolutionPolicy: 'never',
        gitCommit: 'a'.repeat(40),
      },
    });
    expect(host.suggestionCalls).toBe(1);
    expect(host.replyCalls).toBe(1);
    expect(host.resolveCalls).toBe(0);

    const serialized = await readFile(store.path, 'utf8');
    expect(serialized).not.toContain('SECRET_OLD_PASSAGE');
    expect(serialized).not.toContain('SECRET_NEW_PASSAGE');
    expect(serialized).not.toContain('SECRET_REPLY_BODY');
  });

  it('previews without writing a ledger or mutating comments', async () => {
    const { store, host, service } = await fixture();
    const outcome = await service.addressComment({ ...addressInput(), dryRun: true });

    expect(outcome).toMatchObject({ operationId, relatedToComment: true });
    expect(host.suggestionCalls).toBe(0);
    expect(host.replyCalls).toBe(0);
    expect(await store.read('project-1')).toEqual({
      schemaVersion: 1,
      projectId: 'project-1',
      entries: [],
    });
  });

  it('refuses an unrelated edit unless explicitly allowed', async () => {
    const { host, service } = await fixture();
    host.comment.position = 0;
    host.comment.selectedText = 'alpha';

    await expect(service.addressComment(addressInput())).rejects.toMatchObject({
      code: 'COMMENT_CONTEXT_MISMATCH',
    });
    expect(host.suggestionCalls).toBe(0);
  });

  it('resumes the same operation without duplicating suggestion or reply', async () => {
    const { host, service } = await fixture();
    await service.addressComment(addressInput());
    const resumed = await service.addressComment(addressInput());

    expect(resumed).toMatchObject({ operationId, resumed: true });
    expect(host.suggestionCalls).toBe(1);
    expect(host.replyCalls).toBe(1);
  });

  it('resumes comment actions after a verified suggestion and reply failure', async () => {
    const { store, host, service } = await fixture();
    host.failReplyOnce = true;

    await expect(service.addressComment(addressInput())).rejects.toMatchObject({
      code: 'PARTIAL_FAILURE',
    });
    expect((await store.getEntry('project-1', operationId))).toMatchObject({
      state: 'suggested',
      replyStatus: 'failed',
    });

    const resumed = await service.addressComment(addressInput());
    expect(resumed).toMatchObject({ resumed: true, entry: { replyStatus: 'posted' } });
    expect(host.suggestionCalls).toBe(1);
    expect(host.replyCalls).toBe(1);
  });

  it('resolves immediately only under the explicit after-suggest policy', async () => {
    const { host, service } = await fixture();
    const outcome = await service.addressComment(addressInput('after-suggest'));

    expect(outcome).toMatchObject({ entry: { state: 'suggested' } });
    expect(host.resolveCalls).toBe(1);
    expect('entry' in outcome && outcome.entry.commentResolvedAt).toBeTruthy();
  });

  it('classifies acceptance by text hash and resolves after acceptance idempotently', async () => {
    const { host, service } = await fixture();
    await service.addressComment(addressInput('after-accept'));
    host.activeChangeIds = [];
    host.documentSha256 = sha256Text(revised);

    const preview = await service.reconcile({ projectId: 'project-1', dryRun: true });
    expect(preview.items[0]).toMatchObject({
      previousState: 'suggested',
      state: 'accepted',
      commentResolutionPlanned: true,
      commentResolved: false,
    });
    expect(host.resolveCalls).toBe(0);

    const first = await service.reconcile({ projectId: 'project-1' });
    const second = await service.reconcile({ projectId: 'project-1' });
    expect(first.items[0].state).toBe('accepted');
    expect(second.items[0].state).toBe('accepted');
    expect(host.resolveCalls).toBe(1);
  });

  it('classifies rejection by the original hash without resolving the comment', async () => {
    const { host, service } = await fixture();
    await service.addressComment(addressInput('after-accept'));
    host.activeChangeIds = [];
    host.documentSha256 = sha256Text(source);

    const result = await service.reconcile({ projectId: 'project-1' });
    expect(result.items[0].state).toBe('rejected');
    expect(host.resolveCalls).toBe(0);
  });

  it('keeps ambiguous disappearance unknown and leaves the comment open', async () => {
    const { host, service } = await fixture();
    await service.addressComment(addressInput('after-accept'));
    host.activeChangeIds = [];
    host.documentSha256 = sha256Text('some unrelated document state');

    const result = await service.reconcile({ projectId: 'project-1' });
    expect(result.items[0].state).toBe('unknown');
    expect(host.resolveCalls).toBe(0);
  });

  it('annotates a verified commit and emits standard commit trailers', async () => {
    const { service } = await fixture();
    await service.addressComment(addressInput());

    const entry = await service.annotateCommit({
      projectId: 'project-1',
      operationId,
      commit: 'HEAD',
    });
    expect(entry.gitCommit).toBe('a'.repeat(40));
    expect(await service.commitTrailers('project-1', operationId)).toEqual([
      'Overleaf-Project: project-1',
      'Overleaf-Document: doc-1',
      'Overleaf-Thread: thread-1',
      'Overleaf-Changes: insert-1,delete-1',
      'Overleaf-Source-Version: 7',
      `Olcli-Review-Operation: ${operationId}`,
    ]);
  });
});
