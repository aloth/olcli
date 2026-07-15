import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { OlcliError } from '../errors/olcli-error.js';
import type { ReviewLedger, ReviewLedgerEntry } from './types.js';

export const REVIEW_LEDGER_FILENAME = '.olcli-review.json';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

const reviewEntrySchema = z.object({
  operationId: z.string().uuid(),
  threadId: z.string().min(1),
  docId: z.string().min(1),
  path: z.string().min(1),
  sourceVersion: z.number().int().nonnegative(),
  sourceSha256: sha256Schema,
  expectedResultSha256: sha256Schema,
  requestSha256: sha256Schema,
  changeIds: z.array(z.string().min(1)),
  gitCommit: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  state: z.enum(['prepared', 'suggested', 'accepted', 'rejected', 'unknown', 'superseded']),
  resolutionPolicy: z.enum(['never', 'after-suggest', 'after-accept']),
  replySha256: sha256Schema,
  replyStatus: z.enum(['pending', 'posted', 'failed']),
  commentResolvedAt: timestampSchema.optional(),
  lastErrorCode: z.string().min(1).optional(),
}).strict();

const reviewLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  entries: z.array(reviewEntrySchema),
}).strict();

export function validateReviewLedger(value: unknown): ReviewLedger {
  const parsed = reviewLedgerSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function emptyLedger(projectId: string): ReviewLedger {
  return { schemaVersion: 1, projectId, entries: [] };
}

function corruptBackupPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${path}.corrupt-${stamp}`;
}

export class ReviewLedgerStore {
  readonly path: string;

  constructor(path = REVIEW_LEDGER_FILENAME, workingDirectory = process.cwd()) {
    this.path = resolve(workingDirectory, path);
  }

  async read(projectId: string): Promise<ReviewLedger> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger(projectId);
      throw error;
    }

    try {
      const ledger = validateReviewLedger(JSON.parse(raw));
      if (ledger.projectId !== projectId) {
        throw new OlcliError(
          'LEDGER_PROJECT_MISMATCH',
          'Review ledger belongs to a different Overleaf project.',
          { details: { ledgerProjectId: ledger.projectId, requestedProjectId: projectId } }
        );
      }
      return ledger;
    } catch (error) {
      if (error instanceof OlcliError) throw error;

      const backupPath = corruptBackupPath(this.path);
      try {
        await copyFile(this.path, backupPath);
      } catch (backupError) {
        throw new OlcliError(
          'LEDGER_CORRUPT',
          'Review ledger is corrupt and its backup could not be created; the original was not modified.',
          {
            cause: error,
            details: {
              ledgerPath: this.path,
              backupPath,
              backupError: backupError instanceof Error ? backupError.message : String(backupError),
            },
          }
        );
      }
      throw new OlcliError(
        'LEDGER_CORRUPT',
        'Review ledger is corrupt; a backup was created and the original was not modified.',
        { cause: error, details: { ledgerPath: this.path, backupPath } }
      );
    }
  }

  async write(ledger: ReviewLedger): Promise<void> {
    const release = await this.acquireLock();
    try {
      await this.writeUnlocked(ledger);
    } finally {
      await release();
    }
  }

  private async writeUnlocked(ledger: ReviewLedger): Promise<void> {
    const validated = validateReviewLedger(ledger);
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  async update<T>(
    projectId: string,
    mutate: (ledger: ReviewLedger) => T | Promise<T>
  ): Promise<T> {
    const release = await this.acquireLock();
    try {
      const ledger = await this.read(projectId);
      const result = await mutate(ledger);
      await this.writeUnlocked(ledger);
      return result;
    } finally {
      await release();
    }
  }

  async getEntry(projectId: string, operationId: string): Promise<ReviewLedgerEntry> {
    const ledger = await this.read(projectId);
    const entry = ledger.entries.find(item => item.operationId === operationId);
    if (!entry) {
      throw new OlcliError('REVIEW_OPERATION_NOT_FOUND', `Review operation not found: ${operationId}`);
    }
    return entry;
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new OlcliError(
          'REVIEW_OPERATION_CONFLICT',
          'Review ledger is being updated by another process; retry after it finishes.',
          { details: { ledgerPath: this.path } }
        );
      }
      throw error;
    }

    return async () => {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    };
  }
}
