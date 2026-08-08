/**
 * Path helpers for mapping local file paths to remote Overleaf project paths.
 */

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
