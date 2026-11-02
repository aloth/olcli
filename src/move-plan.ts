/**
 * Pure planning logic for `olcli rename|mv` and the MCP tool `rename_entity`.
 *
 * Overleaf has two separate endpoints: `rename` changes an entity's name and
 * keeps its folder, `move` changes its folder and keeps its name. A request
 * such as `mv sub/a.txt chapters/b.txt` therefore needs up to three kinds of
 * writes: create missing folders, rename, move. Every check that can refuse
 * the request runs here, over the project tree, before any of them is sent,
 * so a refusal never leaves a half-done move behind. The same plan feeds the
 * MCP confirmation dialog, which is why it lives apart from the client.
 */

import type { FolderEntry } from './client.js';

export type EntityType = 'doc' | 'file' | 'folder';

export type MoveRefusal = 'not_found' | 'exists' | 'into_itself' | 'not_a_folder' | 'invalid_path' | 'intermediate_clash';

/** A request that was refused before anything was written. */
export class MoveRefusedError extends Error {
  constructor(message: string, readonly reason: MoveRefusal) {
    super(message);
    this.name = 'MoveRefusedError';
  }
}

export interface MovePlan {
  entity: { id: string; type: EntityType; name: string; path: string };
  /** Path of the entity before the change, without a leading slash. */
  from: string;
  /** Path of the entity after the change, without a leading slash. */
  to: string;
  newName: string;
  /** Whether the name changes. */
  rename: boolean;
  /** Whether the folder changes. */
  move: boolean;
  /** True when the entity is already at the destination. Nothing is written. */
  noop: boolean;
  /** Folder the entity ends up in, '' for the project root. */
  targetFolderPath: string;
  /** ID of that folder, or undefined when it is created first. */
  targetFolderId?: string;
  /** Folder of the entity before the change, '' for the project root. */
  sourceFolderPath: string;
  sourceFolderId: string;
  /** Folders that are created, parents first. */
  createFolders: string[];
  /**
   * Order of the two writes when both the name and the folder change. Rename
   * first unless the new name is taken in the source folder; then move first,
   * which is safe because the old name is free in the target folder.
   */
  order: 'rename-then-move' | 'move-then-rename';
  /** IDs of the root and of every existing ancestor of the target folder. */
  knownFolders: Record<string, string>;
}

interface Indexed {
  id: string;
  type: EntityType;
  name: string;
  path: string;
  parentPath: string;
}

function join(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

function checkSegment(segment: string, whole: string): void {
  if (segment === '' || segment === '.' || segment === '..') {
    throw new MoveRefusedError(`Invalid destination path: ${whole}`, 'invalid_path');
  }
}

/**
 * Split the destination as the user wrote it into folder and name.
 *
 * - no `/`: a new name in the current folder (plain rename)
 * - ends in `/`: a folder; the name is kept (`/` alone is the project root)
 * - otherwise: folder part and name; a leading `/` means the project root
 */
export function parseDestination(destination: string, currentFolder: string, currentName: string): { folder: string; name: string } {
  if (!destination.includes('/')) {
    checkSegment(destination, destination);
    return { folder: currentFolder, name: destination };
  }
  const stripped = destination.replace(/^\/+/, '');
  let folder: string;
  let name: string;
  if (stripped === '' || stripped.endsWith('/')) {
    folder = stripped.replace(/\/+$/, '');
    name = currentName;
  } else {
    const cut = stripped.lastIndexOf('/');
    folder = cut === -1 ? '' : stripped.slice(0, cut);
    name = cut === -1 ? stripped : stripped.slice(cut + 1);
    checkSegment(name, destination);
  }
  if (folder) for (const segment of folder.split('/')) checkSegment(segment, destination);
  return { folder, name };
}

function indexTree(root: FolderEntry): { entities: Map<string, Indexed>; order: Indexed[] } {
  const entities = new Map<string, Indexed>();
  const order: Indexed[] = [];
  const add = (entry: Indexed) => {
    entities.set(entry.path, entry);
    order.push(entry);
  };
  const walk = (folder: FolderEntry, path: string) => {
    // Same order as OverleafClient.findEntityByPath: docs, files, folders.
    for (const doc of folder.docs || []) add({ id: doc._id, type: 'doc', name: doc.name, path: join(path, doc.name), parentPath: path });
    for (const file of folder.fileRefs || []) add({ id: file._id, type: 'file', name: file.name, path: join(path, file.name), parentPath: path });
    for (const sub of folder.folders || []) {
      const subPath = join(path, sub.name);
      add({ id: sub._id, type: 'folder', name: sub.name, path: subPath, parentPath: path });
      walk(sub, subPath);
    }
  };
  walk(root, '');
  return { entities, order };
}

/**
 * Work out what `rename|mv <source> <destination>` does in a project tree,
 * or throw MoveRefusedError. Reads only.
 *
 * The source is looked up by its full path; as before, a bare name also
 * matches an entity of that name in any folder.
 */
export function planEntityMove(root: FolderEntry, source: string, destination: string): MovePlan {
  const { entities, order } = indexTree(root);
  const wanted = source.replace(/^\/+/, '').replace(/\/+$/, '');
  let entity = wanted ? entities.get(wanted) : undefined;
  if (!entity && wanted && !wanted.includes('/')) entity = order.find(e => e.name === wanted);
  if (!entity) throw new MoveRefusedError(`File not found: ${source}`, 'not_found');

  const folderId = (path: string): string | undefined => {
    if (path === '') return root._id;
    const found = entities.get(path);
    return found?.type === 'folder' ? found.id : undefined;
  };

  const { folder: targetFolderPath, name: newName } = parseDestination(destination, entity.parentPath, entity.name);
  const to = join(targetFolderPath, newName);

  if (entity.type === 'folder' && (targetFolderPath === entity.path || targetFolderPath.startsWith(`${entity.path}/`))) {
    const message = targetFolderPath === entity.path
      ? `Cannot move folder ${entity.path} into itself`
      : `Cannot move folder ${entity.path} into its own subfolder ${targetFolderPath}`;
    throw new MoveRefusedError(message, 'into_itself');
  }

  // Walk the target folder path: existing folders are reused, the first
  // missing segment and everything below it is created.
  const knownFolders: Record<string, string> = { '': root._id };
  const createFolders: string[] = [];
  if (targetFolderPath) {
    let prefix = '';
    for (const segment of targetFolderPath.split('/')) {
      prefix = join(prefix, segment);
      if (createFolders.length > 0) {
        createFolders.push(prefix);
        continue;
      }
      const existing = entities.get(prefix);
      if (!existing) {
        createFolders.push(prefix);
      } else if (existing.type !== 'folder') {
        throw new MoveRefusedError(`Cannot move into ${targetFolderPath}: ${prefix} is a ${existing.type}, not a folder`, 'not_a_folder');
      } else {
        knownFolders[prefix] = existing.id;
      }
    }
  }

  const sourceFolderId = folderId(entity.parentPath) as string;
  const base = {
    entity: { id: entity.id, type: entity.type, name: entity.name, path: entity.path },
    from: entity.path,
    to,
    newName,
    targetFolderPath,
    targetFolderId: createFolders.length ? undefined : folderId(targetFolderPath),
    sourceFolderPath: entity.parentPath,
    sourceFolderId,
    createFolders,
    knownFolders,
  };

  if (to === entity.path) {
    return { ...base, rename: false, move: false, noop: true, order: 'rename-then-move' };
  }
  if (entities.has(to)) {
    throw new MoveRefusedError(`Destination already exists: ${to}`, 'exists');
  }

  const rename = newName !== entity.name;
  const move = targetFolderPath !== entity.parentPath;
  let planOrder: MovePlan['order'] = 'rename-then-move';
  if (rename && move) {
    // Overleaf refuses a name that is taken in the folder, so the step in
    // between must not collide either.
    const renameClash = entities.has(join(entity.parentPath, newName));
    const moveClash = createFolders.length === 0 && entities.has(join(targetFolderPath, entity.name));
    if (renameClash && moveClash) {
      throw new MoveRefusedError(
        `Cannot move ${entity.path} to ${to} in one step: ${join(entity.parentPath, newName)} and ${join(targetFolderPath, entity.name)} both exist. Rename or move it through a free name first`,
        'intermediate_clash'
      );
    }
    planOrder = renameClash ? 'move-then-rename' : 'rename-then-move';
  }
  return { ...base, rename, move, noop: false, order: planOrder };
}
