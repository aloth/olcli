/**
 * `olcli changes suggest`: reading the edits and describing the plan.
 *
 * Kept out of cli.ts so the parsing and the preview text can be tested
 * without a process or a socket. The edits have the shape of the library's
 * `SuggestionEdit[]` and of the `edits` argument of the MCP tool
 * `suggest_changes`, so one JSON file works for all three.
 */

import type { SuggestionEdit, SuggestionPlan, SuggestionResult } from './client.js';
import { UsageError } from './exit-codes.js';

/** The MCP tool accepts at most this many edits per call; the CLI uses the same limit. */
export const MAX_SUGGESTION_EDITS = 100;

/**
 * Parse and validate the edits. Accepts an array, or an object with an
 * `edits` array (what `--json` output and MCP calls carry). Throws a
 * UsageError naming the first problem, so a bad file exits 2.
 */
export function parseSuggestionEdits(text: string, source = 'the edits'): SuggestionEdit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { edits?: unknown }).edits)
      ? (parsed as { edits: unknown[] }).edits
      : undefined;
  if (!list) {
    throw new UsageError(`${source} must be a JSON array of edits, or an object with an "edits" array`);
  }
  if (list.length === 0) throw new UsageError(`${source} contains no edits`);
  if (list.length > MAX_SUGGESTION_EDITS) {
    throw new UsageError(`${source} contains ${list.length} edits; at most ${MAX_SUGGESTION_EDITS} per run`);
  }
  return list.map((item, index) => {
    const at = `edit ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new UsageError(`${at}: must be an object`);
    const record = item as Record<string, unknown>;
    for (const key of ['before', 'deleted', 'inserted', 'after'] as const) {
      if (typeof record[key] !== 'string') {
        throw new UsageError(`${at}: "${key}" must be a string (use "" for none)`);
      }
    }
    const unknown = Object.keys(record).filter((key) => !['before', 'deleted', 'inserted', 'after', 'hint', 'result'].includes(key));
    if (unknown.length > 0) throw new UsageError(`${at}: unknown field${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `"${k}"`).join(', ')}`);
    const edit: SuggestionEdit = {
      before: record.before as string,
      deleted: record.deleted as string,
      inserted: record.inserted as string,
      after: record.after as string,
    };
    if (record.hint !== undefined) {
      if (typeof record.hint !== 'number' || !Number.isInteger(record.hint) || record.hint < 0) {
        throw new UsageError(`${at}: "hint" must be a non-negative integer`);
      }
      edit.hint = record.hint;
    }
    return edit;
  });
}

/** Why an edit is left alone, per planned outcome. Same words as the MCP dialog. */
export const SUGGESTION_NOTES: Record<string, string> = {
  suggest: 'becomes a suggestion',
  'already-tracked': 'already a tracked change, left alone',
  'not-pushed': 'Overleaf still has the old text, left alone',
  'not-found': 'neither the old nor the new text is in the document, left alone',
  unchanged: 'old and new text are the same, left alone',
  invalid: 'before, inserted and after are all empty, so it cannot be found, left alone',
};

function quote(text: string, max = 60): string {
  const shown = text.length > max ? `${text.slice(0, max)}...` : text;
  return JSON.stringify(shown);
}

/** The preview, one block per edit: where, and what becomes a suggestion or why not. */
export function describeSuggestionPlan(plan: SuggestionPlan): string[] {
  const lines: string[] = [];
  plan.edits.forEach((item, index) => {
    const where = item.line !== undefined ? ` ${plan.path}:${item.line}:${item.column}` : '';
    lines.push(`${index + 1}.${where} ${SUGGESTION_NOTES[item.outcome] ?? item.outcome}`);
    if (item.outcome !== 'suggest') return;
    if (item.edit.deleted) lines.push(`   suggested deletion:  ${quote(item.edit.deleted)}`);
    if (item.edit.inserted) lines.push(`   suggested insertion: ${quote(item.edit.inserted)}`);
    lines.push(`   between ${quote(item.edit.before, 30)} and ${quote(item.edit.after, 30)}`);
  });
  return lines;
}

/** The `--json` value of a preview: one entry per edit with its planned outcome and location. */
export function suggestionPlanJson(plan: SuggestionPlan): object {
  return {
    applied: false,
    path: plan.path,
    version: plan.version,
    edits: plan.edits.map((item) => ({
      ...item.edit,
      outcome: item.outcome,
      ...(item.line !== undefined ? { line: item.line, column: item.column } : {}),
    })),
  };
}

/** The `--json` value after writing: one entry per edit with its result. */
export function suggestionResultJson(path: string, edits: SuggestionEdit[], results: SuggestionResult[]): object {
  return { applied: true, path, results: edits.map((edit, index) => ({ ...edit, result: results[index] })) };
}
