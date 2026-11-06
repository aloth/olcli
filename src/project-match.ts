/**
 * Find a project by what the user typed.
 *
 * Order, first hit wins:
 *   1. exact name (case-sensitive), so two projects that differ only in case
 *      can still be told apart
 *   2. exact name, case-insensitive
 *   3. a unique case-insensitive prefix
 *
 * Several projects sharing the name or the prefix is an error that lists
 * them; nothing matching is an error that suggests the closest names. Both
 * are typed so callers can exit non-zero without parsing the message.
 */

export interface NamedProject {
  id: string;
  name: string;
}

export class ProjectNotFoundError extends Error {
  readonly query: string;
  readonly suggestions: string[];

  constructor(query: string, suggestions: string[]) {
    const hint = suggestions.length > 0
      ? `\nDid you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`
      : '\nList your projects with: olcli list';
    super(`Project not found: ${query}${hint}`);
    this.name = 'ProjectNotFoundError';
    this.query = query;
    this.suggestions = suggestions;
  }
}

export class AmbiguousProjectError extends Error {
  readonly query: string;
  readonly candidates: NamedProject[];

  constructor(query: string, candidates: NamedProject[]) {
    const shown = candidates.slice(0, 10).map((p) => `  ${p.name}  (${p.id})`);
    if (candidates.length > 10) shown.push(`  ... and ${candidates.length - 10} more`);
    super(`"${query}" matches ${candidates.length} projects:\n${shown.join('\n')}\nUse the full name or the project ID.`);
    this.name = 'AmbiguousProjectError';
    this.query = query;
    this.candidates = candidates;
  }
}

/** Levenshtein distance; names are short, so the quadratic table is fine. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[y.length];
}

const fold = (s: string): string => s.normalize('NFC').toLocaleLowerCase();

/**
 * Up to `limit` project names closest to `query`: names containing it first,
 * then by edit distance, dropping anything further than about half the query.
 */
export function suggestProjectNames(projects: NamedProject[], query: string, limit = 3): string[] {
  const q = fold(query);
  const maxDistance = Math.max(2, Math.ceil(q.length / 2));
  const scored = projects.map((p) => {
    const name = fold(p.name);
    const contains = name.includes(q) || (name.length >= 3 && q.includes(name));
    // Compare against the start of the name as well, so a short query for a
    // long title is not dismissed for the length difference alone.
    const distance = Math.min(editDistance(q, name), editDistance(q, name.slice(0, q.length)) + 1);
    return { name: p.name, contains, distance };
  });
  return scored
    .filter((s) => s.contains || s.distance <= maxDistance)
    .sort((a, b) => Number(b.contains) - Number(a.contains) || a.distance - b.distance || a.name.localeCompare(b.name))
    .map((s) => s.name)
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, limit);
}

/** Resolve `query` to one project or throw ProjectNotFoundError / AmbiguousProjectError. */
export function matchProject<T extends NamedProject>(projects: T[], query: string): T {
  const exact = projects.filter((p) => p.name === query);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new AmbiguousProjectError(query, exact);

  const q = fold(query);
  const insensitive = projects.filter((p) => fold(p.name) === q);
  if (insensitive.length === 1) return insensitive[0];
  if (insensitive.length > 1) throw new AmbiguousProjectError(query, insensitive);

  const prefixed = q ? projects.filter((p) => fold(p.name).startsWith(q)) : [];
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) throw new AmbiguousProjectError(query, prefixed);

  throw new ProjectNotFoundError(query, suggestProjectNames(projects, query));
}
