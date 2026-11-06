/**
 * Path helpers for mapping local file paths to remote Overleaf project paths.
 */

import { resolve, sep } from 'node:path';

/**
 * Safely resolve a (possibly attacker-controlled) relative path, such as a
 * zip entry name, inside a base directory.
 *
 * Protects against "zip-slip" path traversal: entry names containing '..'
 * segments, absolute paths, or Windows drive letters that would escape the
 * base directory are rejected.
 *
 * Returns the absolute resolved path when it is strictly inside `baseDir`,
 * or `null` when the path would escape (or resolve to) the base directory.
 */
export function resolveWithin(baseDir: string, relativePath: string): string | null {
  const base = resolve(baseDir);
  const target = resolve(base, relativePath);
  if (target === base) return null;
  if (!target.startsWith(base + sep)) return null;
  return target;
}

/**
 * Normalize a path intended to be used as a remote path inside an Overleaf
 * project.
 *
 * - Converts backslashes to forward slashes (Windows-friendly).
 * - Drops '.' segments and collapses duplicate slashes.
 * - Resolves '..' segments; any that would escape the project root are dropped.
 * - Strips leading slashes so the result is always project-relative.
 *
 * Returns an empty string when nothing usable is left.
 */
export function normalizeRemotePath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Escaping the project root is meaningless remotely - drop the segment.
      out.pop();
      continue;
    }
    out.push(segment);
  }

  return out.join('/');
}

/**
 * Derive the remote path for an uploaded file.
 *
 * Precedence:
 *   1. An explicit destination (`--to` / `remote_path`) always wins.
 *   2. Absolute local paths collapse to their basename. Mirroring the local
 *      filesystem hierarchy from '/' into a project is never the intent, and
 *      previously produced remote paths like 'tmp/tmp.abc123/paper.tex'.
 *   3. Relative local paths keep their directory part, so
 *      'figures/diagram.png' still lands in the 'figures' folder.
 */
export function resolveRemotePath(localPath: string, destination?: string): string {
  if (destination) {
    const normalized = normalizeRemotePath(destination);
    if (!normalized) {
      throw new Error(`Invalid destination path: ${destination}`);
    }
    return normalized;
  }

  const unixStyle = localPath.replace(/\\/g, '/');
  const isAbsolute = unixStyle.startsWith('/') || /^[a-zA-Z]:\//.test(unixStyle);

  if (isAbsolute) {
    const baseName = unixStyle.split('/').filter(Boolean).pop();
    if (!baseName) {
      throw new Error(`Cannot derive a remote path from: ${localPath}`);
    }
    return baseName;
  }

  const normalized = normalizeRemotePath(unixStyle);
  if (!normalized) {
    throw new Error(`Cannot derive a remote path from: ${localPath}`);
  }
  return normalized;
}

/**
 * Old local name for a project title: everything outside [a-zA-Z0-9-_]
 * became "_". Kept so that a directory created by olcli 0.15 or earlier can
 * still be found; see `defaultProjectDir`.
 */
export function legacyLocalName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]/g, '_');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME_BYTES = 200;

/**
 * A project title as a local file or directory name.
 *
 * Letters, digits and symbols from any script are kept, including emoji, so
 * "Masterarbeit Müller" stays readable instead of becoming
 * "Masterarbeit_M_ller". Replaced with "_": whitespace (as before, so ASCII
 * titles keep the names they had), characters that are unsafe in a path on
 * any platform (/ \ : * ? " < > |) and control characters. Leading dots and
 * trailing dots or spaces are dropped, Windows device names get a suffix, and
 * the result is capped at 200 UTF-8 bytes without splitting a character.
 */
export function safeLocalName(name: string): string {
  let out = name
    .normalize('NFC')
    .trim()
    // Windows drops trailing dots and spaces, and a leading dot hides the
    // directory on Unix; neither belongs to the title.
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/\s/g, '_');
  if (WINDOWS_RESERVED.test(out.split('.')[0])) out = `${out}_`;

  if (Buffer.byteLength(out) > MAX_NAME_BYTES) {
    let cut = '';
    for (const ch of out) {
      if (Buffer.byteLength(cut + ch) > MAX_NAME_BYTES) break;
      cut += ch;
    }
    out = cut;
  }
  return out || 'project';
}
