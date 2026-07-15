import { OlcliError } from '../errors/olcli-error.js';
import type {
  DiffHistoryOptions,
  HistoryAuthor,
  HistoryDiffChunk,
  HistoryDiffChunkKind,
  HistoryEntry,
  HistoryFileChange,
  HistoryFileDiffResult,
  HistoryLabel,
  HistoryListResult,
  HistoryOrigin,
  HistoryProjectOperation,
  HistoryServiceHost,
  ListHistoryOptions,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidResponse(`Invalid history timestamp: ${field}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalidResponse(`Invalid history timestamp: ${field}`);
  return date.toISOString();
}

function optionalTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return timestamp(value, 'meta timestamp');
}

function invalidResponse(message: string, details: Record<string, unknown> = {}): OlcliError {
  return new OlcliError('HISTORY_RESPONSE_INVALID', message, { details });
}

function displayName(user: UnknownRecord): string {
  const firstName = typeof user.first_name === 'string' ? user.first_name : '';
  const lastName = typeof user.last_name === 'string' ? user.last_name : '';
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) return fullName;
  return 'Unknown';
}

export function normalizeHistoryAuthors(value: unknown): HistoryAuthor[] {
  if (!Array.isArray(value)) return [];
  const authors: HistoryAuthor[] = [];
  const seen = new Set<string>();
  for (const rawUser of value) {
    if (rawUser == null) {
      if (!seen.has('anonymous')) {
        seen.add('anonymous');
        authors.push({ name: 'Anonymous' });
      }
      continue;
    }
    const user = record(rawUser);
    if (!user) continue;
    const id = typeof user.id === 'string' && user.id ? user.id : undefined;
    const name = displayName(user);
    const key = id || `name:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push({ ...(id ? { id } : {}), name });
  }
  return authors;
}

function normalizeLabel(value: unknown): HistoryLabel {
  const label = record(value);
  if (!label || typeof label.id !== 'string' || typeof label.comment !== 'string') {
    throw invalidResponse('History label is missing its ID or comment.');
  }
  if (!safeInteger(label.version)) throw invalidResponse('History label has an invalid version.');
  const createdAt = typeof label.created_at === 'string'
    && !Number.isNaN(Date.parse(label.created_at))
    ? new Date(label.created_at).toISOString()
    : undefined;
  return {
    id: label.id,
    comment: label.comment,
    version: label.version,
    ...(createdAt ? { createdAt } : {}),
    ...(typeof label.user_id === 'string' ? { authorId: label.user_id } : {}),
    ...(typeof label.user_display_name === 'string'
      ? { authorName: label.user_display_name }
      : {}),
  };
}

function normalizeProjectOperation(value: unknown): HistoryProjectOperation {
  const operation = record(value);
  if (!operation || !safeInteger(operation.atV)) {
    throw invalidResponse('History project operation has an invalid version.');
  }
  for (const kind of ['add', 'remove', 'rename'] as const) {
    const detail = record(operation[kind]);
    if (!detail) continue;
    if (typeof detail.pathname !== 'string' || !detail.pathname) {
      throw invalidResponse('History project operation has an invalid path.');
    }
    if (kind === 'rename') {
      if (typeof detail.newPathname !== 'string' || !detail.newPathname) {
        throw invalidResponse('History rename operation has an invalid destination path.');
      }
      return {
        kind,
        atVersion: operation.atV,
        path: detail.pathname,
        newPath: detail.newPathname,
      };
    }
    return { kind, atVersion: operation.atV, path: detail.pathname };
  }
  throw invalidResponse('History project operation has no recognized action.');
}

function normalizeOrigin(value: unknown): HistoryOrigin | undefined {
  const origin = record(value);
  if (!origin || typeof origin.kind !== 'string') return undefined;
  return {
    kind: origin.kind,
    ...(typeof origin.path === 'string' ? { path: origin.path } : {}),
    ...(origin.timestamp !== undefined
      ? { timestamp: timestamp(origin.timestamp, 'origin.timestamp') }
      : {}),
    ...(safeInteger(origin.version) ? { version: origin.version } : {}),
  };
}

export function normalizeHistoryEntry(value: unknown): HistoryEntry {
  const update = record(value);
  if (!update || !safeInteger(update.fromV) || !safeInteger(update.toV)) {
    throw invalidResponse('History update has invalid version bounds.');
  }
  if (update.toV <= update.fromV) {
    throw invalidResponse('History update version bounds are not increasing.', {
      fromVersion: update.fromV,
      toVersion: update.toV,
    });
  }
  const meta = record(update.meta);
  if (!meta) throw invalidResponse('History update is missing metadata.');
  if (!Array.isArray(update.pathnames) || !update.pathnames.every(path => typeof path === 'string')) {
    throw invalidResponse('History update has invalid pathnames.');
  }
  if (!Array.isArray(update.project_ops) || !Array.isArray(update.labels)) {
    throw invalidResponse('History update is missing project operations or labels.');
  }

  const origin = normalizeOrigin(meta.origin);
  return {
    id: `${update.fromV}:${update.toV}`,
    fromVersion: update.fromV,
    toVersion: update.toV,
    startedAt: timestamp(meta.start_ts, 'meta.start_ts'),
    endedAt: timestamp(meta.end_ts, 'meta.end_ts'),
    authors: normalizeHistoryAuthors(meta.users),
    pathnames: [...update.pathnames] as string[],
    projectOperations: update.project_ops.map(normalizeProjectOperation),
    labels: update.labels.map(normalizeLabel),
    ...(origin ? { origin } : {}),
    external: meta.type === 'external' || meta.source === 'git-bridge',
  };
}

function normalizeFileChange(value: unknown): HistoryFileChange {
  const file = record(value);
  if (!file || typeof file.pathname !== 'string' || !file.pathname) {
    throw invalidResponse('History file-tree entry has an invalid path.');
  }
  const operations = ['added', 'removed', 'edited', 'renamed'] as const;
  const operation = operations.includes(file.operation as typeof operations[number])
    ? file.operation as typeof operations[number]
    : 'unchanged';
  return {
    path: file.pathname,
    operation,
    ...(typeof file.editable === 'boolean' ? { editable: file.editable } : {}),
    ...(typeof file.oldPathname === 'string' ? { oldPath: file.oldPathname } : {}),
    ...(typeof file.newPathname === 'string' ? { newPath: file.newPathname } : {}),
    ...(safeInteger(file.deletedAtV) ? { deletedAtVersion: file.deletedAtV } : {}),
  };
}

export function normalizeHistoryFileTreeResponse(value: unknown): HistoryFileChange[] {
  const response = record(value);
  if (!response || !Array.isArray(response.diff)) {
    throw invalidResponse('History file-tree diff response is malformed.');
  }
  return response.diff.map(normalizeFileChange);
}

interface NormalizedRawDiff {
  binary: boolean;
  chunks: HistoryDiffChunk[];
  insertedCharacters: number;
  deletedCharacters: number;
  unchangedCharacters: number;
}

export function normalizeHistoryDocDiffResponse(
  value: unknown,
  options: DiffHistoryOptions = {}
): NormalizedRawDiff {
  const response = record(value);
  if (!response || response.diff === undefined) {
    throw invalidResponse('History document diff response is malformed.');
  }
  const binary = record(response.diff);
  if (binary?.binary === true) {
    return {
      binary: true,
      chunks: [],
      insertedCharacters: 0,
      deletedCharacters: 0,
      unchangedCharacters: 0,
    };
  }
  if (!Array.isArray(response.diff)) {
    throw invalidResponse('History document diff is neither text chunks nor binary metadata.');
  }

  const includeContent = options.includeContent !== false;
  const includeUnchanged = options.includeUnchanged === true;
  const chunks: HistoryDiffChunk[] = [];
  let offset = 0;
  let insertedCharacters = 0;
  let deletedCharacters = 0;
  let unchangedCharacters = 0;

  for (const [index, rawChunk] of response.diff.entries()) {
    const chunk = record(rawChunk);
    if (!chunk) throw invalidResponse('History diff chunk is malformed.', { index });
    const candidates: Array<[HistoryDiffChunkKind, unknown]> = [
      ['unchanged', chunk.u],
      ['insert', chunk.i],
      ['delete', chunk.d],
    ];
    const populated = candidates.filter(([, content]) => typeof content === 'string');
    if (populated.length !== 1) {
      throw invalidResponse('History diff chunk must contain exactly one text operation.', { index });
    }
    const [kind, rawText] = populated[0] as [HistoryDiffChunkKind, string];
    const length = rawText.length;
    if (kind === 'insert') insertedCharacters += length;
    else if (kind === 'delete') deletedCharacters += length;
    else unchangedCharacters += length;

    const meta = record(chunk.meta);
    const normalized: HistoryDiffChunk = {
      kind,
      offset,
      length,
      ...(includeContent ? { text: rawText } : {}),
      authors: normalizeHistoryAuthors(meta?.users),
      ...(meta ? { startedAt: optionalTimestamp(meta.start_ts) } : {}),
      ...(meta ? { endedAt: optionalTimestamp(meta.end_ts) } : {}),
    };
    if (kind !== 'unchanged' || includeUnchanged) chunks.push(normalized);
    offset += length;
  }

  return {
    binary: false,
    chunks,
    insertedCharacters,
    deletedCharacters,
    unchangedCharacters,
  };
}

function assertIntegerOption(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum?: number
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    throw new OlcliError('HISTORY_VERSION_INVALID', `${name} must be an integer between ${minimum} and ${maximum ?? '∞'}.`);
  }
}

export class HistoryService {
  constructor(private readonly host: HistoryServiceHost) {}

  async listHistory(
    projectId: string,
    options: ListHistoryOptions = {}
  ): Promise<HistoryListResult> {
    const limit = options.limit ?? 50;
    const minCount = options.minCount ?? 10;
    assertIntegerOption(limit, 'limit', 1, 200);
    assertIntegerOption(minCount, 'minCount', 1, 100);
    assertIntegerOption(options.before, 'before', 0);

    const entries: HistoryEntry[] = [];
    const seenEntries = new Set<string>();
    const seenCursors = new Set<number>();
    let cursor = options.before;
    let serverNext: number | undefined;
    let exhausted = false;

    while (entries.length < limit && !exhausted) {
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw invalidResponse('History pagination returned a repeated cursor.', { cursor });
        }
        seenCursors.add(cursor);
      }
      const query = new URLSearchParams({ min_count: String(minCount) });
      if (cursor !== undefined) query.set('before', String(cursor));
      const raw = await this.host.getHistoryJson(
        `/project/${encodeURIComponent(projectId)}/updates?${query}`
      );
      const response = record(raw);
      if (!response || !Array.isArray(response.updates)) {
        throw invalidResponse('History updates response is malformed.');
      }
      const page = response.updates.map(normalizeHistoryEntry);
      for (const entry of page) {
        if (seenEntries.has(entry.id)) continue;
        seenEntries.add(entry.id);
        entries.push(entry);
      }
      serverNext = safeInteger(response.nextBeforeTimestamp)
        ? response.nextBeforeTimestamp
        : undefined;
      exhausted = page.length === 0 || serverNext === undefined;
      cursor = serverNext;
    }

    const selected = entries.slice(0, limit);
    const last = selected[selected.length - 1];
    const truncated = entries.length > limit;
    const nextBefore = last && last.fromVersion > 0 && (truncated || !exhausted)
      ? last.fromVersion
      : undefined;
    return {
      projectId,
      entries: selected,
      ...(nextBefore !== undefined ? { nextBefore } : {}),
      atEnd: nextBefore === undefined,
    };
  }

  async diffFile(
    projectId: string,
    filePath: string,
    fromVersion: number,
    toVersion: number,
    options: DiffHistoryOptions = {}
  ): Promise<HistoryFileDiffResult> {
    assertIntegerOption(fromVersion, 'fromVersion', 0);
    assertIntegerOption(toVersion, 'toVersion', 1);
    if (toVersion <= fromVersion) {
      throw new OlcliError(
        'HISTORY_VERSION_INVALID',
        'toVersion must be greater than fromVersion.'
      );
    }
    const path = filePath.replace(/^\/+/, '');
    if (!path) throw new OlcliError('HISTORY_FILE_NOT_FOUND', 'History diff requires a file path.');

    const range = new URLSearchParams({
      from: String(fromVersion),
      to: String(toVersion),
    });
    const fileTreeRaw = await this.host.getHistoryJson(
      `/project/${encodeURIComponent(projectId)}/filetree/diff?${range}`
    );
    const files = normalizeHistoryFileTreeResponse(fileTreeRaw);
    const file = files.find(candidate => (
      candidate.path === path || candidate.oldPath === path || candidate.newPath === path
    ));
    if (!file) {
      throw new OlcliError(
        'HISTORY_FILE_NOT_FOUND',
        `File is not present in the selected history range: ${path}`,
        { details: { path, fromVersion, toVersion } }
      );
    }

    const diffQuery = new URLSearchParams({
      from: String(fromVersion),
      to: String(toVersion),
      pathname: file.path,
    });
    const diffRaw = await this.host.getHistoryJson(
      `/project/${encodeURIComponent(projectId)}/diff?${diffQuery}`
    );
    const normalized = normalizeHistoryDocDiffResponse(diffRaw, options);
    return {
      projectId,
      path: file.path,
      fromVersion,
      toVersion,
      file,
      binary: normalized.binary,
      chunks: normalized.chunks,
      stats: {
        insertedCharacters: normalized.insertedCharacters,
        deletedCharacters: normalized.deletedCharacters,
        unchangedCharacters: normalized.unchangedCharacters,
      },
    };
  }
}
