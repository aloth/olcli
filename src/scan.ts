/**
 * Shared local-file scanning.
 *
 * `push`, `sync` and `diff` all need the same answer to "which files in this
 * directory are in play": walk the tree, skip dotfiles, apply the ignore
 * layers, and report what was skipped. That walk previously existed twice,
 * once inside `push` and once inside `sync`, with the two copies already
 * drifting apart. A third copy in `diff` would have made it three.
 *
 * Deliberately does NOT read file contents. `push` only ever reads the files
 * it is about to upload, and eagerly loading every file here would change its
 * memory profile on large projects. Callers that need contents read them from
 * `path` themselves.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { shouldIgnore, buildTexSiblingSet, type IgnoreContext } from './ignore.js';

export interface LocalFile {
  /**
   * Project-relative path with forward slashes. This is the key that lines up
   * with remote entry names, `.olcli.json` manifests, and ignore patterns.
   */
  relativePath: string;
  /** Path as passed to `fs`, relative to the scan root's own base. */
  path: string;
  mtime: Date;
}

export interface LocalScan {
  files: LocalFile[];
  /**
   * Paths skipped by the ignore layers, for `--show-ignored`. Directories
   * carry a trailing slash and their contents are not descended into.
   */
  ignored: string[];
}

/**
 * Walk `root`, returning every file that survives ignore filtering.
 *
 * Hidden entries (anything starting with `.`) are skipped unconditionally,
 * which is also what keeps `.olcli.json`, `.olauth` and `.git/` out of every
 * caller. That rule predates the ignore subsystem and is not configurable.
 */
export function scanLocalFiles(root: string, ctx: IgnoreContext): LocalScan {
  const files: LocalFile[] = [];
  const ignored: string[] = [];

  function walk(currentDir: string, relativeBase: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    // Pre-compute the sibling .tex set for the PDF special rule.
    const texSiblings = buildTexSiblingSet(
      entries.filter((e) => !e.isDirectory()).map((e) => e.name),
    );

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(currentDir, entry.name);
      const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // gitignore semantics: a trailing slash matches a directory.
        if (shouldIgnore(`${relativePath}/`, ctx)) {
          ignored.push(`${relativePath}/`);
          continue;
        }
        walk(fullPath, relativePath);
      } else {
        if (shouldIgnore(relativePath, ctx, texSiblings)) {
          ignored.push(relativePath);
          continue;
        }
        files.push({ relativePath, path: fullPath, mtime: statSync(fullPath).mtime });
      }
    }
  }

  walk(root, '');
  return { files, ignored };
}
