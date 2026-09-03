/**
 * Content-level comparison between a local directory and a remote Overleaf
 * project.
 *
 * Pure functions only: no network, no filesystem, no colour. The command in
 * `cli.ts` fetches both sides and renders; everything decided here is decided
 * from two maps of `path -> bytes`, which is what makes it unit-testable
 * without an Overleaf account. Same reasoning as `rename-plan.ts`.
 *
 * Orientation is fixed and matters: **`a/` is the remote, `b/` is local**, so
 * a `+` line is content that a subsequent `push` would put on Overleaf and a
 * `-` line is content it would overwrite. Reading the diff the other way round
 * would invert the meaning of every hunk.
 */

import { createTwoFilesPatch } from 'diff';
import { shouldIgnore, buildTexSiblingSet, type IgnoreContext } from './ignore.js';

export type FileStatus = 'added' | 'deleted' | 'modified' | 'unchanged';

export interface FileDiff {
  /** Project-relative path, forward slashes. */
  path: string;
  /**
   * From the point of view of a push:
   *   added     - local only; `push` uploads it
   *   deleted   - remote only; plain `push` leaves it, `push --delete` removes it
   *   modified  - both sides, different bytes; `push` overwrites the remote
   *   unchanged - both sides, identical bytes
   */
  status: FileStatus;
  /** True when either side looks binary; such files are never rendered as text. */
  binary: boolean;
}

/**
 * How many leading bytes to sniff when deciding whether a file is binary.
 * Same window git uses.
 */
const BINARY_SNIFF_BYTES = 8000;

/**
 * A NUL byte near the start means "do not try to render this as text".
 *
 * Crude on purpose. The alternative - content-type sniffing per extension -
 * gets PDFs and images right and then quietly mangles the next format nobody
 * anticipated. Reporting "binary files differ" is always safe.
 */
export function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface RemoteEntry {
  /** Entry name as it appears in the project archive. */
  path: string;
  data: Buffer;
}

/**
 * Reduce a project archive listing to the files the local scan would also have
 * reported, so the two sides of a diff are filtered identically.
 *
 * Applying the ignore layers to only the local side would list every artifact
 * Overleaf keeps in the project - `output.pdf` above all - as a file missing
 * locally, which is noise on every single run. The dotfile rule is mirrored
 * for the same reason: the local scan never reports them, so a remote
 * `.latexmkrc` would otherwise always look locally deleted.
 *
 * @param isSafePath  Rejects archive entries whose names escape the target
 *                    directory. `diff` never writes these files out, but an
 *                    entry `pull` refuses to extract is not part of the project
 *                    as far as this directory is concerned, and showing it
 *                    would suggest a difference that no push could resolve.
 */
export function filterRemoteTree(
  entries: RemoteEntry[],
  ctx: IgnoreContext,
  isSafePath: (path: string) => boolean = () => true,
): Map<string, Buffer> {
  const normalized = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, '/') }));
  const texSiblings = buildRemoteTexSiblings(normalized.map((e) => e.path));

  const out = new Map<string, Buffer>();
  for (const entry of normalized) {
    if (!isSafePath(entry.path)) continue;
    if (entry.path.split('/').some((seg) => seg.startsWith('.'))) continue;
    if (shouldIgnore(entry.path, ctx, texSiblings.get(folderOf(entry.path)))) continue;
    out.set(entry.path, entry.data);
  }
  return out;
}

function folderOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Per-folder sets of basenames that have a `.tex`/`.ltx` companion, which is
 * what the ignore subsystem's PDF sibling rule needs. The local scanner gets
 * this for free from `readdir`; a flat archive listing has to be regrouped.
 */
function buildRemoteTexSiblings(paths: string[]): Map<string, Set<string>> {
  const byFolder = new Map<string, string[]>();
  for (const path of paths) {
    const folder = folderOf(path);
    const name = folder ? path.slice(folder.length + 1) : path;
    const list = byFolder.get(folder);
    if (list) list.push(name);
    else byFolder.set(folder, [name]);
  }

  const out = new Map<string, Set<string>>();
  for (const [folder, names] of byFolder) {
    out.set(folder, buildTexSiblingSet(names));
  }
  return out;
}

/**
 * Compare two file trees.
 *
 * Both maps are keyed by project-relative, forward-slash paths. Callers are
 * responsible for having applied the same ignore rules to both sides;
 * comparing a filtered local tree against an unfiltered remote one would
 * report every build artifact on Overleaf as "deleted".
 *
 * Results are sorted by path so output is stable across runs.
 */
export function compareTrees(
  local: Map<string, Buffer>,
  remote: Map<string, Buffer>,
): FileDiff[] {
  const paths = new Set<string>([...local.keys(), ...remote.keys()]);
  const out: FileDiff[] = [];

  for (const path of [...paths].sort()) {
    const localBuf = local.get(path);
    const remoteBuf = remote.get(path);

    if (localBuf && !remoteBuf) {
      out.push({ path, status: 'added', binary: isBinary(localBuf) });
    } else if (!localBuf && remoteBuf) {
      out.push({ path, status: 'deleted', binary: isBinary(remoteBuf) });
    } else if (localBuf && remoteBuf) {
      const identical = localBuf.equals(remoteBuf);
      out.push({
        path,
        status: identical ? 'unchanged' : 'modified',
        binary: isBinary(localBuf) || isBinary(remoteBuf),
      });
    }
  }

  return out;
}

export interface RenderOptions {
  /** Lines of context around each hunk. Defaults to 3, like git. */
  context?: number;
}

/**
 * Render one file's change as a unified diff.
 *
 * Returns an empty string for unchanged files. Binary files get a single
 * summary line instead of a patch.
 */
export function renderFileDiff(
  entry: FileDiff,
  localBuf: Buffer | undefined,
  remoteBuf: Buffer | undefined,
  options: RenderOptions = {},
): string {
  if (entry.status === 'unchanged') return '';

  const oldName = entry.status === 'added' ? '/dev/null' : `a/${entry.path}`;
  const newName = entry.status === 'deleted' ? '/dev/null' : `b/${entry.path}`;
  const header = `diff --olcli a/${entry.path} b/${entry.path}`;

  if (entry.binary) {
    return `${header}\nBinary files ${oldName} and ${newName} differ\n`;
  }

  const oldText = remoteBuf ? remoteBuf.toString('utf-8') : '';
  const newText = localBuf ? localBuf.toString('utf-8') : '';

  // A non-numeric --unified reaches us as NaN, which jsdiff turns into an
  // empty patch rather than an error. Fall back instead.
  const context = Number.isInteger(options.context) && options.context! >= 0
    ? options.context!
    : 3;

  const patch = createTwoFilesPatch(oldName, newName, oldText, newText, undefined, undefined, {
    context,
  });

  // jsdiff prefixes every patch with a '====' separator line that only makes
  // sense when concatenating multiple patches into one file. Drop it and use
  // a git-shaped header instead, so the output pastes into tools that already
  // understand unified diffs.
  const body = patch.replace(/^=+\n/, '');

  return `${header}\n${body}`;
}

/** One-letter status prefix for `--name-only` output, mirroring `git status`. */
export function statusLetter(status: FileStatus): string {
  switch (status) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'modified': return 'M';
    case 'unchanged': return ' ';
  }
}
