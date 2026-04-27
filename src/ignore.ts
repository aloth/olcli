/**
 * olcli ignore subsystem
 *
 * Layered defense against syncing local LaTeX build artifacts (and other
 * unwanted files) up to Overleaf:
 *
 *   1. Built-in ignore list  — always on, opt out with --no-default-ignore
 *   2. .olignore             — project-level, gitignore-style syntax
 *   3. .olignore.local       — machine-specific, never synced (gitignore'd)
 *
 * Special PDF rule: ignore `X.pdf` only if a same-named `X.tex` (or `.ltx`)
 * exists in the same folder. This kills `thesis.pdf` next to `thesis.tex`
 * but preserves a hand-uploaded `figures/diagram.pdf`.
 *
 * Escape hatches:
 *   --no-default-ignore  → only .olignore + .olignore.local apply
 *   --no-ignore          → no filtering at all
 *
 * See issue #19 for design rationale.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import ignore, { Ignore } from 'ignore';

/**
 * Default ignore patterns, applied unless --no-default-ignore is set.
 *
 * Covers LaTeX build artifacts (pdflatex / xelatex / lualatex / latexmk /
 * biber / makeindex / glossaries / minted), common editor noise, and
 * conventional build directories.
 *
 * Note: `*.pdf` is NOT in this list — see shouldIgnore() for the special
 * sibling-`.tex` rule.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = Object.freeze([
  // ─── LaTeX core build artifacts ───────────────────────────────────────
  '*.aux', '*.bbl', '*.blg', '*.log', '*.out', '*.toc',
  '*.lof', '*.lot',
  // latexmk
  '*.fls', '*.fdb_latexmk',
  // synctex
  '*.synctex.gz', '*.synctex',
  // Beamer
  '*.nav', '*.snm', '*.vrb',
  // makeindex
  '*.idx', '*.ind', '*.ilg',
  // glossaries
  '*.glo', '*.gls', '*.glg', '*.acn', '*.acr', '*.alg',
  '*.ist', '*.xdy',
  // biber / biblatex
  '*.bcf', '*.run.xml',
  // xelatex / dvi
  '*.xdv', '*.dvi',
  // pdflatex aux variants
  '*.pyg',                       // minted pygments cache leftover
  // ─── Build directories ────────────────────────────────────────────────
  '_minted-*/',
  'build/', 'out/', 'dist/',
  // ─── Editor / OS noise ────────────────────────────────────────────────
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
  '*.swp', '*.swo', '*~', '*.bak',
  // ─── Overleaf-specific reserved ───────────────────────────────────────
  'output.pdf',                  // Overleaf compile output convention
]);

/**
 * Resolved ignore configuration for a project directory.
 */
export interface IgnoreContext {
  /** All effective patterns in priority order (later overrides earlier). */
  patterns: string[];
  /** Sources contributing to `patterns`, for `olcli ignored` output. */
  sources: Array<{
    label: string;
    patterns: string[];
  }>;
  /** True when defaults are enabled. */
  defaultsEnabled: boolean;
  /** True when ignore filtering is enabled at all. */
  enabled: boolean;
  /** Compiled matcher; null when `enabled === false`. */
  matcher: Ignore | null;
}

export interface LoadIgnoreOptions {
  /** Disable the built-in DEFAULT_IGNORE_PATTERNS list. */
  noDefaults?: boolean;
  /** Disable all ignore filtering entirely (overrides everything else). */
  disableAll?: boolean;
}

/**
 * Read patterns from a .olignore-style file. Returns [] if missing.
 * Comments (# …) and blank lines are stripped by the `ignore` package
 * itself; we just split on newlines.
 */
function readIgnoreFile(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Build an IgnoreContext for the given project root.
 *
 * Layering (lowest → highest precedence; `ignore` semantics: later wins):
 *   1. DEFAULT_IGNORE_PATTERNS   (unless noDefaults)
 *   2. <root>/.olignore          (project, version-controlled)
 *   3. <root>/.olignore.local    (machine-only, gitignore'd)
 */
export function loadIgnore(root: string, opts: LoadIgnoreOptions = {}): IgnoreContext {
  if (opts.disableAll) {
    return {
      patterns: [],
      sources: [],
      defaultsEnabled: false,
      enabled: false,
      matcher: null,
    };
  }

  const sources: IgnoreContext['sources'] = [];

  if (!opts.noDefaults) {
    sources.push({
      label: 'built-in defaults',
      patterns: [...DEFAULT_IGNORE_PATTERNS],
    });
  }

  const projectIgnore = readIgnoreFile(join(root, '.olignore'));
  if (projectIgnore.length > 0) {
    sources.push({ label: '.olignore', patterns: projectIgnore });
  }

  const localIgnore = readIgnoreFile(join(root, '.olignore.local'));
  if (localIgnore.length > 0) {
    sources.push({ label: '.olignore.local', patterns: localIgnore });
  }

  const patterns = sources.flatMap((s) => s.patterns);
  const matcher = ignore().add(patterns);

  return {
    patterns,
    sources,
    defaultsEnabled: !opts.noDefaults,
    enabled: true,
    matcher,
  };
}

/**
 * Decide whether a given relative path should be ignored.
 *
 * @param relativePath  Path relative to the project root, forward-slash.
 *                      For directories, callers may pass `dir/` (trailing
 *                      slash) to engage gitignore directory matching.
 * @param ctx           From `loadIgnore`.
 * @param siblingTexBaseNames  Set of file basenames (without extension) in
 *                      the same folder as `relativePath` that have a `.tex`
 *                      or `.ltx` source. Used for the PDF special rule.
 *                      Pass `undefined` to skip the PDF rule.
 */
export function shouldIgnore(
  relativePath: string,
  ctx: IgnoreContext,
  siblingTexBaseNames?: Set<string>,
): boolean {
  if (!ctx.enabled || !ctx.matcher) return false;

  // The `ignore` package requires forward slashes and rejects leading `/`.
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized === '' || normalized === '.') return false;

  if (ctx.matcher.ignores(normalized)) return true;

  // Special PDF rule (only when defaults active — it's a default-list policy):
  // ignore `X.pdf` if a sibling `X.tex` (or .ltx) exists.
  if (
    ctx.defaultsEnabled &&
    siblingTexBaseNames &&
    /\.pdf$/i.test(normalized)
  ) {
    const base = basename(normalized).replace(/\.pdf$/i, '');
    if (siblingTexBaseNames.has(base.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Convenience: build a per-folder set of basenames that have a `.tex` or
 * `.ltx` companion. Caller passes the list of files in that folder (just
 * basenames, not full paths).
 */
export function buildTexSiblingSet(folderFileNames: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const name of folderFileNames) {
    const m = name.match(/^(.+)\.(tex|ltx)$/i);
    if (m) out.add(m[1].toLowerCase());
  }
  return out;
}
