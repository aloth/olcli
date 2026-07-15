import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { OlcliError } from '../errors/olcli-error.js';
import type { ReviewLedgerEntry } from './types.js';

const execFileAsync = promisify(execFile);

export async function resolveGitCommit(
  workingDirectory: string,
  ref = 'HEAD'
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--verify', `${ref}^{commit}`],
      { cwd: workingDirectory, encoding: 'utf8' }
    );
    const commit = stdout.trim();
    return /^[a-f0-9]{40,64}$/i.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

export async function requireGitCommit(
  workingDirectory: string,
  ref = 'HEAD'
): Promise<string> {
  const commit = await resolveGitCommit(workingDirectory, ref);
  if (!commit) {
    throw new OlcliError(
      'REVIEW_OPERATION_CONFLICT',
      `Git commit could not be resolved: ${ref}`
    );
  }
  return commit;
}

export function reviewCommitTrailers(entry: ReviewLedgerEntry, projectId: string): string[] {
  return [
    `Overleaf-Project: ${projectId}`,
    `Overleaf-Document: ${entry.docId}`,
    `Overleaf-Thread: ${entry.threadId}`,
    `Overleaf-Changes: ${entry.changeIds.join(',')}`,
    `Overleaf-Source-Version: ${entry.sourceVersion}`,
    `Olcli-Review-Operation: ${entry.operationId}`,
  ];
}
