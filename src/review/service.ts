import { randomUUID } from 'node:crypto';

import { sha256Text } from '../changes/matcher.js';
import type { SuggestChangeInput, SuggestionResult } from '../changes/types.js';
import { OlcliError } from '../errors/olcli-error.js';
import { resolveGitCommit, reviewCommitTrailers } from './git-metadata.js';
import { ReviewLedgerStore } from './ledger.js';
import type {
  AddressReviewCommentInput,
  AddressReviewPreview,
  AddressReviewResult,
  AnnotateReviewCommitInput,
  ReconcileReviewInput,
  ReconcileReviewItem,
  ReconcileReviewResult,
  ReviewLedger,
  ReviewLedgerEntry,
  ReviewResolutionPolicy,
  ReviewServiceHost,
  ReviewStatusInput,
  ReviewStorageOptions,
} from './types.js';

export interface ReviewServiceOptions extends ReviewStorageOptions {
  ledgerStore?: ReviewLedgerStore;
  now?: () => Date;
  operationId?: () => string;
  gitCommitResolver?: (workingDirectory: string, ref?: string) => Promise<string | undefined>;
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

function errorCode(error: unknown): string {
  return error instanceof OlcliError ? error.code : 'UNKNOWN_ERROR';
}

function assertResolutionPolicy(value: ReviewResolutionPolicy): void {
  if (!['never', 'after-suggest', 'after-accept'].includes(value)) {
    throw new OlcliError('PROTOCOL_ERROR', `Unsupported review resolution policy: ${value}`);
  }
}

function requestFingerprint(
  input: AddressReviewCommentInput,
  policy: ReviewResolutionPolicy
): string {
  return sha256Text(JSON.stringify({
    threadId: input.threadId,
    path: normalizePath(input.filePath),
    oldText: input.oldText,
    newText: input.newText,
    occurrence: input.occurrence ?? null,
    position: input.position ?? null,
    line: input.line ?? null,
    column: input.column ?? null,
    reply: input.reply ?? null,
    resolutionPolicy: policy,
    allowUnrelated: input.allowUnrelated === true,
  }));
}

function relatedToComment(
  commentPosition: number,
  selectedLength: number,
  editPosition: number,
  replacedLength: number
): boolean {
  const commentEnd = commentPosition + selectedLength;
  if (replacedLength === 0) {
    return editPosition >= commentPosition && editPosition <= commentEnd;
  }
  const editEnd = editPosition + replacedLength;
  return editPosition < commentEnd && editEnd > commentPosition;
}

function suggestionInput(
  input: AddressReviewCommentInput,
  precondition = input.precondition
): SuggestChangeInput {
  return {
    projectId: input.projectId,
    filePath: input.filePath,
    oldText: input.oldText,
    newText: input.newText,
    occurrence: input.occurrence,
    position: input.position,
    line: input.line,
    column: input.column,
    precondition,
  };
}

function defaultReply(entry: ReviewLedgerEntry): string {
  const commit = entry.gitCommit ? ` Git commit: ${entry.gitCommit}.` : '';
  return `Proposed a tracked revision in ${entry.path}. Change IDs: ${entry.changeIds.join(', ')}.${commit}`;
}

function cloneEntry(entry: ReviewLedgerEntry): ReviewLedgerEntry {
  return { ...entry, changeIds: [...entry.changeIds] };
}

export class ReviewService {
  private readonly host: ReviewServiceHost;
  private readonly ledger: ReviewLedgerStore;
  private readonly workingDirectory: string;
  private readonly now: () => Date;
  private readonly operationId: () => string;
  private readonly gitCommitResolver: NonNullable<ReviewServiceOptions['gitCommitResolver']>;

  constructor(host: ReviewServiceHost, options: ReviewServiceOptions = {}) {
    this.host = host;
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.ledger = options.ledgerStore || new ReviewLedgerStore(
      options.ledgerPath,
      this.workingDirectory
    );
    this.now = options.now || (() => new Date());
    this.operationId = options.operationId || randomUUID;
    this.gitCommitResolver = options.gitCommitResolver || resolveGitCommit;
  }

  async addressComment(
    input: AddressReviewCommentInput
  ): Promise<AddressReviewPreview | AddressReviewResult> {
    const policy = input.resolutionPolicy || 'never';
    assertResolutionPolicy(policy);
    const operationId = input.operationId || this.operationId();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operationId)) {
      throw new OlcliError('REVIEW_OPERATION_CONFLICT', 'Review operation ID must be a UUID.');
    }

    const requestSha256 = requestFingerprint(input, policy);
    if (!input.dryRun) {
      const existingLedger = await this.ledger.read(input.projectId);
      const existing = existingLedger.entries.find(entry => entry.operationId === operationId);
      if (existing) {
        if (existing.threadId !== input.threadId || existing.requestSha256 !== requestSha256) {
          throw new OlcliError(
            'REVIEW_OPERATION_CONFLICT',
            'Review operation ID is already associated with a different request.',
            { details: { operationId } }
          );
        }
        if (existing.state === 'prepared') {
          throw new OlcliError(
            'REVIEW_OPERATION_CONFLICT',
            'Prepared review operation has an uncertain mutation outcome; reconcile it before retrying.',
            { details: { operationId } }
          );
        }
        const resumed = await this.completeCommentActions(
          input.projectId,
          existing,
          input.reply
        );
        return { operationId, resumed: true, entry: resumed };
      }
    }

    const comment = await this.host.getComment(input.projectId, input.threadId);
    if (comment.resolved) {
      throw new OlcliError(
        'COMMENT_ALREADY_RESOLVED',
        `Comment thread is already resolved: ${input.threadId}`
      );
    }

    const preview = await this.host.previewTrackedSuggestion(suggestionInput(input));
    const normalizedInputPath = normalizePath(input.filePath);
    if (comment.docId !== preview.docId || normalizePath(comment.path) !== normalizePath(preview.path)) {
      throw new OlcliError(
        'COMMENT_CONTEXT_MISMATCH',
        'The requested document does not contain the selected comment thread.',
        {
          details: {
            commentPath: comment.path,
            requestedPath: normalizedInputPath,
          },
        }
      );
    }

    const related = relatedToComment(
      comment.position,
      comment.selectedText.length,
      preview.position,
      input.oldText.length
    );
    if (!related && !input.allowUnrelated) {
      throw new OlcliError(
        'COMMENT_CONTEXT_MISMATCH',
        'The proposed edit does not overlap the comment selection. Use allowUnrelated only after manual review.',
        {
          details: {
            commentPosition: comment.position,
            commentLength: comment.selectedText.length,
            editPosition: preview.position,
            editLength: input.oldText.length,
          },
        }
      );
    }

    const gitCommit = await this.gitCommitResolver(this.workingDirectory);
    if (input.dryRun) {
      return {
        operationId,
        threadId: input.threadId,
        path: preview.path,
        relatedToComment: related,
        resolutionPolicy: policy,
        gitCommit,
        suggestion: preview,
      };
    }

    const timestamp = this.now().toISOString();
    const initialReply = input.reply || `Proposed a tracked revision in ${preview.path}.`;
    const preparedEntry: ReviewLedgerEntry = {
      operationId,
      threadId: input.threadId,
      docId: preview.docId,
      path: preview.path,
      sourceVersion: preview.version,
      sourceSha256: preview.textSha256,
      expectedResultSha256: preview.expectedResultSha256,
      requestSha256,
      changeIds: [],
      gitCommit,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: 'prepared',
      resolutionPolicy: policy,
      replySha256: sha256Text(initialReply),
      replyStatus: 'pending',
    };
    await this.ledger.update(input.projectId, ledger => {
      ledger.entries.push(preparedEntry);
    });

    let suggestion: SuggestionResult;
    try {
      const outcome = await this.host.suggestTrackedChange(suggestionInput(input, {
        expectedVersion: preview.version,
        expectedTextSha256: preview.textSha256,
      }));
      if (!('changeIds' in outcome)) {
        throw new OlcliError('VERIFICATION_FAILED', 'Review mutation returned a preview instead of a result.');
      }
      suggestion = outcome;
    } catch (error) {
      await this.recordError(input.projectId, operationId, errorCode(error));
      throw new OlcliError(
        'PARTIAL_FAILURE',
        'Review operation did not complete; its prepared ledger entry was retained for safe reconciliation.',
        {
          cause: error,
          details: { operationId, operationErrorCode: errorCode(error) },
        }
      );
    }

    const suggestedEntry = await this.ledger.update(input.projectId, ledger => {
      const entry = this.requireEntry(ledger, operationId);
      entry.sourceVersion = suggestion.beforeVersion;
      entry.sourceSha256 = suggestion.textSha256;
      entry.expectedResultSha256 = suggestion.expectedResultSha256;
      entry.changeIds = [...suggestion.changeIds];
      entry.state = 'suggested';
      entry.updatedAt = this.now().toISOString();
      const reply = input.reply || defaultReply(entry);
      entry.replySha256 = sha256Text(reply);
      delete entry.lastErrorCode;
      return cloneEntry(entry);
    });

    try {
      const completedEntry = await this.completeCommentActions(
        input.projectId,
        suggestedEntry,
        input.reply
      );
      return { operationId, resumed: false, entry: completedEntry, suggestion };
    } catch (error) {
      await this.recordError(input.projectId, operationId, errorCode(error), 'failed');
      throw new OlcliError(
        'PARTIAL_FAILURE',
        'Tracked suggestion was created, but the comment workflow did not finish. Retry with the same operation ID.',
        {
          cause: error,
          details: {
            operationId,
            changeIds: suggestion.changeIds,
            operationErrorCode: errorCode(error),
          },
        }
      );
    }
  }

  async status(input: ReviewStatusInput): Promise<ReviewLedger> {
    return this.ledger.read(input.projectId);
  }

  async reconcile(input: ReconcileReviewInput): Promise<ReconcileReviewResult> {
    const ledger = await this.ledger.read(input.projectId);
    const selectedIds = input.operationIds ? new Set(input.operationIds) : undefined;
    if (selectedIds && selectedIds.size !== input.operationIds!.length) {
      throw new OlcliError('REVIEW_OPERATION_CONFLICT', 'Duplicate review operation IDs are not allowed.');
    }
    if (selectedIds) {
      for (const operationId of selectedIds) this.requireEntry(ledger, operationId);
    }

    // Overleaf's legacy collaboration server can drop joinDoc acknowledgements
    // when one account opens concurrent sessions for the same project. Keep
    // these reads serialized and cache their completed values per path.
    const changesByPath = new Map<string, Array<{ id: string }>>();
    const inspectionByPath = new Map<string, Awaited<ReturnType<ReviewServiceHost['inspectTrackedDocument']>>>();
    const items: ReconcileReviewItem[] = [];
    const nextEntries = ledger.entries.map(cloneEntry);

    for (const entry of nextEntries) {
      if (selectedIds && !selectedIds.has(entry.operationId)) continue;

      let changes = changesByPath.get(entry.path);
      if (!changes) {
        changes = await this.host.listTrackedChanges(input.projectId, { filePath: entry.path });
        changesByPath.set(entry.path, changes);
      }
      let document = inspectionByPath.get(entry.path);
      if (!document) {
        document = await this.host.inspectTrackedDocument(input.projectId, entry.path);
        inspectionByPath.set(entry.path, document);
      }
      const currentIds = new Set(changes.map(change => change.id));
      const activeChangeIds = entry.changeIds.filter(id => currentIds.has(id));
      const previousState = entry.state;

      if (entry.changeIds.length === 0) {
        entry.state = document.textSha256 === entry.sourceSha256 ? 'prepared' : 'unknown';
      } else if (activeChangeIds.length === entry.changeIds.length) {
        entry.state = 'suggested';
      } else if (activeChangeIds.length > 0) {
        entry.state = 'unknown';
      } else if (
        entry.expectedResultSha256 !== entry.sourceSha256
        && document.textSha256 === entry.expectedResultSha256
      ) {
        entry.state = 'accepted';
      } else if (document.textSha256 === entry.sourceSha256) {
        entry.state = 'rejected';
      } else {
        entry.state = 'unknown';
      }

      let comment = await this.host.getComment(input.projectId, entry.threadId);
      const shouldResolve = (
        entry.resolutionPolicy === 'after-suggest'
        && (entry.state === 'suggested' || entry.state === 'accepted')
      ) || (
        entry.resolutionPolicy === 'after-accept'
        && entry.state === 'accepted'
      );
      const commentResolutionPlanned = shouldResolve && !comment.resolved;
      if (!input.dryRun && commentResolutionPlanned) {
        await this.host.resolveComment(input.projectId, entry.threadId);
        comment = { ...comment, resolved: true };
      }
      if (!input.dryRun) {
        entry.updatedAt = this.now().toISOString();
        if (comment.resolved && !entry.commentResolvedAt) {
          entry.commentResolvedAt = this.now().toISOString();
        }
        delete entry.lastErrorCode;
      }

      items.push({
        operationId: entry.operationId,
        previousState,
        state: entry.state,
        activeChangeIds,
        document,
        commentResolved: comment.resolved,
        commentResolutionPlanned,
      });
    }

    if (!input.dryRun) {
      const originalById = new Map(ledger.entries.map(entry => [entry.operationId, entry]));
      await this.ledger.update(input.projectId, current => {
        for (const item of items) {
          const original = originalById.get(item.operationId)!;
          const candidate = nextEntries.find(entry => entry.operationId === item.operationId)!;
          const stored = this.requireEntry(current, item.operationId);
          if (
            stored.updatedAt !== original.updatedAt
            || stored.requestSha256 !== original.requestSha256
          ) {
            throw new OlcliError(
              'REVIEW_OPERATION_CONFLICT',
              'Review operation changed during reconciliation; no ledger updates were written.',
              { details: { operationId: item.operationId } }
            );
          }
          Object.assign(stored, candidate, { changeIds: [...candidate.changeIds] });
        }
      });
    }
    return { projectId: input.projectId, dryRun: input.dryRun === true, items };
  }

  async annotateCommit(input: AnnotateReviewCommitInput): Promise<ReviewLedgerEntry> {
    const ref = input.commit || 'HEAD';
    const commit = await this.gitCommitResolver(this.workingDirectory, ref);
    if (!commit) {
      throw new OlcliError(
        'REVIEW_OPERATION_CONFLICT',
        `Git commit could not be resolved: ${ref}`
      );
    }
    return this.ledger.update(input.projectId, ledger => {
      const entry = this.requireEntry(ledger, input.operationId);
      entry.gitCommit = commit;
      entry.updatedAt = this.now().toISOString();
      return cloneEntry(entry);
    });
  }

  async commitTrailers(projectId: string, operationId: string): Promise<string[]> {
    const entry = await this.ledger.getEntry(projectId, operationId);
    return reviewCommitTrailers(entry, projectId);
  }

  private async completeCommentActions(
    projectId: string,
    sourceEntry: ReviewLedgerEntry,
    explicitReply?: string
  ): Promise<ReviewLedgerEntry> {
    let entry = cloneEntry(sourceEntry);
    const reply = explicitReply || defaultReply(entry);
    let comment = await this.host.getComment(projectId, entry.threadId);
    const replyAlreadyPresent = comment.messages.some(message => message.content === reply);

    if (!replyAlreadyPresent && entry.replyStatus !== 'posted') {
      await this.host.postCommentMessage(projectId, entry.threadId, reply);
    }
    entry = await this.ledger.update(projectId, ledger => {
      const stored = this.requireEntry(ledger, entry.operationId);
      stored.replyStatus = 'posted';
      stored.replySha256 = sha256Text(reply);
      stored.updatedAt = this.now().toISOString();
      delete stored.lastErrorCode;
      return cloneEntry(stored);
    });

    if (entry.resolutionPolicy === 'after-suggest') {
      comment = await this.host.getComment(projectId, entry.threadId);
      if (!comment.resolved) await this.host.resolveComment(projectId, entry.threadId);
      entry = await this.ledger.update(projectId, ledger => {
        const stored = this.requireEntry(ledger, entry.operationId);
        if (!stored.commentResolvedAt) stored.commentResolvedAt = this.now().toISOString();
        stored.updatedAt = this.now().toISOString();
        return cloneEntry(stored);
      });
    }

    return entry;
  }

  private async recordError(
    projectId: string,
    operationId: string,
    code: string,
    replyStatus?: ReviewLedgerEntry['replyStatus']
  ): Promise<void> {
    await this.ledger.update(projectId, ledger => {
      const entry = this.requireEntry(ledger, operationId);
      entry.lastErrorCode = code;
      if (replyStatus) entry.replyStatus = replyStatus;
      entry.updatedAt = this.now().toISOString();
    });
  }

  private requireEntry(ledger: ReviewLedger, operationId: string): ReviewLedgerEntry {
    const entry = ledger.entries.find(item => item.operationId === operationId);
    if (!entry) {
      throw new OlcliError('REVIEW_OPERATION_NOT_FOUND', `Review operation not found: ${operationId}`);
    }
    return entry;
  }
}
