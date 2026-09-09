/**
 * `latexdiff` integration for `olcli diff`.
 *
 * `diff` already computes both sides of the comparison - the project as it is
 * on Overleaf right now, and the working directory - and prints them as
 * unified patches. That is the right artifact for a developer and the wrong
 * one for a thesis advisor, who expects the revision marked up in the document
 * itself. `latexdiff` produces that, and the only parts a user cannot do by
 * hand are getting the remote side onto disk and compiling the result without
 * a local TeX installation.
 *
 * Everything decidable from data is decided here as a pure function so it can
 * be unit-tested with no Overleaf account and no `latexdiff` binary; the spawn
 * and the upload/compile/delete sequence stay in `cli.ts` with the rest of the
 * IO. Same split as `diff.ts`.
 *
 * Orientation matches `diff.ts` and is not negotiable: **old is the remote,
 * new is local**. Struck-through text in the markup is content a subsequent
 * push would overwrite, underlined text is content it would upload.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveWithin } from './paths.js';

const execFileAsync = promisify(execFile);

/** Binary looked up on PATH. Not configurable; `latexdiff` is its only name. */
export const LATEXDIFF_BIN = 'latexdiff';

/**
 * Directory the marked-up files are written to, relative to the target
 * directory.
 *
 * Dotted on purpose. `scanLocalFiles` skips dotted entries unconditionally,
 * before any ignore rule is consulted, so this is the one location whose
 * contents cannot leak into a later `push`. A plain `main-diff.tex` next to
 * the document would be uploaded to Overleaf on the next sync.
 */
export const DIFF_OUTPUT_DIR = '.olcli-diff';

/**
 * Name of the file `--pdf` uploads to the project for the duration of one
 * compile.
 *
 * Fixed rather than randomized: a name a user can recognize and delete by hand
 * is worth more than one that never collides, and a collision is refused
 * rather than resolved anyway.
 */
export const REMOTE_SCRATCH_NAME = 'olcli-latexdiff.tex';

/** Extensions treated as LaTeX source when looking for the root document. */
const TEX_EXTENSIONS = ['.tex', '.ltx'];

/**
 * Drop the comment part of a single line of TeX.
 *
 * A `%` starts a comment unless it is escaped, and `\\%` is an escaped
 * backslash followed by a comment, so the run of backslashes before the `%`
 * has to be counted rather than just the character in front of it.
 */
function stripTexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return line.slice(0, i);
  }
  return line;
}

/**
 * True when the file declares a document class outside of a comment.
 *
 * This is what separates a root document from the chapters it inputs. A
 * commented-out `\documentclass` is common in subfiles - people leave the
 * standalone preamble behind when they split a document up - and counting it
 * would report every chapter as a candidate root.
 */
export function declaresDocumentClass(content: Buffer): boolean {
  const text = content.toString('utf-8');
  return text
    .split('\n')
    .some((line) => /\\documentclass\s*[[{]/.test(stripTexComment(line)));
}

export function isTexPath(path: string): boolean {
  const lower = path.toLowerCase();
  return TEX_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Every `.tex` file in the tree that declares a document class, sorted by path
 * so the list a user is shown is stable across runs.
 */
export function findRootCandidates(files: Map<string, Buffer>): string[] {
  return [...files.keys()]
    .filter((path) => isTexPath(path))
    .filter((path) => declaresDocumentClass(files.get(path)!))
    .sort();
}

/** Raised when the root document cannot be determined; carries the advice. */
export class RootDocumentError extends Error {
  constructor(message: string, readonly candidates: string[] = []) {
    super(message);
    this.name = 'RootDocumentError';
  }
}

/**
 * Decide which document to mark up.
 *
 * An explicit `--main` always wins, including for layouts this heuristic
 * cannot read. Otherwise the document class is the signal, and ambiguity is
 * reported rather than guessed at: a project holding both `paper.tex` and
 * `poster.tex` has no correct default, and marking up the wrong one produces a
 * plausible PDF describing the wrong revision - the failure that is hardest to
 * notice.
 *
 * @param files  The local tree, already filtered the same way `diff` filters it.
 */
export function resolveRootDocument(files: Map<string, Buffer>, explicit?: string): string {
  if (explicit) {
    if (!files.has(explicit)) {
      throw new RootDocumentError(
        `Root document not found locally: ${explicit}\n` +
        '  It must be a file in the target directory that diff also reports ' +
        '(an ignore rule can hide it).',
      );
    }
    return explicit;
  }

  const candidates = findRootCandidates(files);

  if (candidates.length === 1) return candidates[0];

  if (candidates.length === 0) {
    throw new RootDocumentError(
      'No .tex file declaring \\documentclass was found, so there is no root document to mark up.\n' +
      '  Pass --main <path> to name one.',
    );
  }

  throw new RootDocumentError(
    `${candidates.length} files declare \\documentclass, so the root document is ambiguous.\n` +
    '  Pass --main <path> to choose one.',
    candidates,
  );
}

export interface LatexdiffArgsOptions {
  /**
   * Inline `\input` and `\include` before comparing. On by default; see
   * `buildLatexdiffArgs`.
   */
  flatten?: boolean;
  /** Verbatim `latexdiff` options from `--latexdiff-opt`, passed through. */
  extra?: string[];
}

/**
 * Build the `latexdiff` argument list.
 *
 * `--flatten` is the default, and the reason is the remote compile rather than
 * taste. Without it the marked-up file still contains `\input{sections/intro}`,
 * and compiling it on Overleaf resolves those against the files sitting in the
 * project - the old content - so a multi-file thesis would produce a PDF that
 * marks up the root document and silently shows every input file as unchanged.
 * `--no-flatten` is there for anyone who wants the raw single-file markup.
 *
 * Extra options come before the file arguments because `latexdiff` reads the
 * last two positional arguments as old and new.
 */
export function buildLatexdiffArgs(
  oldPath: string,
  newPath: string,
  options: LatexdiffArgsOptions = {},
): string[] {
  const args: string[] = [];
  if (options.flatten !== false) args.push('--flatten');
  args.push(...(options.extra ?? []));
  args.push(oldPath, newPath);
  return args;
}

/**
 * Where a marked-up artifact is written, relative to the target directory.
 *
 * Flat rather than mirroring the root document's folder: the output of a
 * flattened run is a single self-contained file, and burying it under
 * `.olcli-diff/chapters/` would only make it harder to find.
 */
export function diffOutputPath(rootPath: string, extension: string): string {
  const base = rootPath.split('/').pop()!.replace(/\.(tex|ltx)$/i, '');
  return `${DIFF_OUTPUT_DIR}/${base}-diff.${extension}`;
}

/**
 * Project path `--pdf` uploads the marked-up file to.
 *
 * Placed next to the root document rather than at the project root, so that
 * relative `\includegraphics` and `\bibliography` paths in the flattened file
 * resolve exactly as they do for the document it was built from.
 */
export function remoteScratchPath(rootPath: string): string {
  const folder = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/')) : '';
  return folder ? `${folder}/${REMOTE_SCRATCH_NAME}` : REMOTE_SCRATCH_NAME;
}

/**
 * Write a file tree to a directory, for use as `latexdiff`'s old side.
 *
 * `latexdiff --flatten` resolves `\input` relative to each side's own file, so
 * the remote tree has to exist on disk with its folder structure intact -
 * handing it just the root document would break every input in a multi-file
 * project.
 *
 * Entry names are re-checked against the destination even though `diff` has
 * already filtered them against the target directory: this writes files, and a
 * path that was safe relative to one base is not automatically safe relative
 * to another. See #44.
 */
export function materializeTree(destination: string, files: Map<string, Buffer>): number {
  let written = 0;
  for (const [path, data] of files) {
    const target = resolveWithin(destination, path);
    if (!target) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written++;
  }
  return written;
}

export interface LatexdiffResult {
  /** The marked-up document, as printed to stdout. */
  markup: string;
  /** Warnings `latexdiff` printed while succeeding. */
  stderr: string;
}

/**
 * Raised when `latexdiff` could not be run or exited non-zero. `missing`
 * separates "not installed" - a setup problem with a known fix - from a real
 * failure on the documents, which needs the tool's own message.
 */
export class LatexdiffError extends Error {
  constructor(message: string, readonly missing: boolean, readonly stderr = '') {
    super(message);
    this.name = 'LatexdiffError';
  }
}

/**
 * Run `latexdiff`, returning its stdout.
 *
 * `execFile`, never a shell: the arguments include user-supplied paths and
 * pass-through options, and an argv array cannot be talked into running
 * something else.
 *
 * The default `maxBuffer` is 1 MB, which a flattened thesis passes without
 * trying. Exceeding it truncates stdout and reports it as an error, which
 * would read as "latexdiff failed" on exactly the documents this feature
 * exists for.
 */
export async function runLatexdiff(args: string[]): Promise<LatexdiffResult> {
  try {
    const { stdout, stderr } = await execFileAsync(LATEXDIFF_BIN, args, {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return { markup: stdout, stderr };
  } catch (error) {
    // execFile rejects with the spawn error for a missing binary and with the
    // captured streams for a non-zero exit; `code` carries the errno in the
    // first case and the exit status in the second.
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === 'ENOENT') {
      throw new LatexdiffError(`${LATEXDIFF_BIN} was not found on PATH`, true);
    }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
    throw new LatexdiffError(
      `${LATEXDIFF_BIN} exited with status ${failure.code ?? 'unknown'}`,
      false,
      stderr,
    );
  }
}

/**
 * Install advice for a missing binary, by platform.
 *
 * `latexdiff` ships with TeX Live and MacTeX, so on most machines the answer
 * is that the whole distribution is missing rather than this one tool - which
 * is also the case where `--pdf` is most useful, since it needs no local TeX.
 */
export function latexdiffInstallHint(platform: string = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'Install MacTeX (brew install --cask mactex-no-gui) or brew install latexdiff';
    case 'win32':
      return 'Install MiKTeX or TeX Live; both ship latexdiff';
    default:
      return 'Install it from your TeX distribution (apt install latexdiff, or TeX Live)';
  }
}
