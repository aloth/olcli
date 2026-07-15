import { basename, isAbsolute, normalize } from 'node:path';

/**
 * Map a local upload argument to its default project path.
 *
 * Relative paths preserve useful subfolders. Absolute paths and paths that
 * escape the current directory default to their basename so local machine
 * directories are never recreated inside an Overleaf project.
 */
export function defaultUploadRemotePath(localPath: string): string {
  const slashPath = localPath.replace(/\\/g, '/');
  if (
    isAbsolute(localPath)
    || /^[a-zA-Z]:\//.test(slashPath)
    || slashPath === '..'
    || slashPath.startsWith('../')
  ) {
    return basename(slashPath);
  }

  const normalized = normalize(localPath).replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../')) {
    return basename(normalized);
  }
  return normalized.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}
