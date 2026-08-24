/**
 * Pure planning logic for bulk project renames.
 *
 * Lives apart from the CLI so the MCP surface can compute and inspect the same
 * plan without going through argument parsing. Two copies of these rules would
 * drift, and the collision check is exactly the part that must not.
 */

export interface RenameCandidate {
  id: string;
  name: string;
}

export interface PlannedRename {
  id: string;
  from: string;
  to: string;
}

export interface SkippedRename {
  name: string;
  reason: string;
}

export interface RenamePlanOptions {
  /** Only consider projects whose name matches this regex source. */
  match?: string;
  /** Literal substring to replace. Takes precedence over regex replacement. */
  search?: string;
  /** Replacement text. Supports $1/$2 backrefs when used with `match`. */
  replace?: string;
  prefix?: string;
  suffix?: string;
}

export interface RenamePlan {
  planned: PlannedRename[];
  skipped: SkippedRename[];
  /** Human-readable collision descriptions. Non-empty means: do not apply. */
  collisions: string[];
}

export class RenamePlanError extends Error {}

/**
 * Build the rename plan. Never performs I/O and never mutates its input.
 *
 * Throws RenamePlanError for operator mistakes (no transform, bad regex) so the
 * caller can surface them before anything touches the network.
 */
export function planProjectRenames(
  projects: RenameCandidate[],
  options: RenamePlanOptions
): RenamePlan {
  const hasTransform =
    options.replace !== undefined || Boolean(options.prefix) || Boolean(options.suffix);
  if (!hasTransform) {
    throw new RenamePlanError('Nothing to do: pass replace, prefix or suffix.');
  }
  if (options.replace !== undefined && !options.search && !options.match) {
    throw new RenamePlanError('replace needs either search (literal) or match (regex).');
  }

  let matcher: RegExp | undefined;
  if (options.match) {
    try {
      matcher = new RegExp(options.match);
    } catch (err: unknown) {
      throw new RenamePlanError(
        `Invalid match regex: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const planned: PlannedRename[] = [];
  const skipped: SkippedRename[] = [];

  for (const p of projects) {
    if (matcher && !matcher.test(p.name)) continue;

    let next = p.name;
    if (options.replace !== undefined) {
      if (options.search) {
        // split/join rather than replaceAll so the needle is always literal:
        // project names routinely contain regex metacharacters like . ( ) [ ]
        next = next.split(options.search).join(options.replace);
      } else if (matcher) {
        next = next.replace(matcher, options.replace);
      }
    }
    if (options.prefix) next = `${options.prefix}${next}`;
    if (options.suffix) next = `${next}${options.suffix}`;

    next = next.trim();

    if (!next) {
      skipped.push({ name: p.name, reason: 'result would be empty' });
      continue;
    }
    if (next === p.name) continue;
    planned.push({ id: p.id, from: p.name, to: next });
  }

  // Overleaf tolerates duplicate project names, which makes a collision worse
  // rather than harmless: nothing fails, and afterwards two projects are
  // indistinguishable in every listing and in `olcli list`.
  const targetCounts = new Map<string, number>();
  for (const p of planned) targetCounts.set(p.to, (targetCounts.get(p.to) ?? 0) + 1);

  const existing = new Set(projects.map((p) => p.name));
  const renamedAway = new Set(planned.map((p) => p.from));

  const collisions: string[] = [];
  for (const [name, count] of targetCounts) {
    if (count > 1) {
      collisions.push(`${name} (${count} projects map to it)`);
    } else if (existing.has(name) && !renamedAway.has(name)) {
      collisions.push(`${name} (an untouched project already has this name)`);
    }
  }

  return { planned, skipped, collisions };
}
