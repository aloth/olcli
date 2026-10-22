/**
 * Write confirmation for the MCP server: the policy switch, the text of the
 * confirmation dialog, and the CLI command offered when a client cannot show
 * one.
 *
 * Pure functions only, for the same reason as `diff.ts` and
 * `tracked-changes.ts`: what the user is asked is decided from data alone, so
 * it is unit-testable without an Overleaf account or an MCP client. The
 * elicitation round trip itself lives in `mcp-server.ts`.
 *
 * Why the gate exists: document text, comments, tracked changes, and file
 * names are written by project collaborators and reach the agent verbatim.
 * Text placed there can instruct the agent to call a write tool. Hiding the
 * text would make review impossible, so the check sits outside the agent:
 * the server asks the user directly (MCP elicitation) and writes only on an
 * explicit yes.
 */

import { formatAuthor } from './tracked-changes.js';
import type { TrackedChange } from './client.js';

/**
 * Whether MCP tools that change an Overleaf project ask the user before
 * writing. This is the default; `OLCLI_MCP_UNCONFIRMED_WRITES` overrides it
 * per server process. Flip this one line to change the default.
 */
export const CONFIRM_WRITES_BY_DEFAULT = true;

/** Set to 1 to write without asking, as olcli 0.15.0 and earlier did. */
export const UNCONFIRMED_WRITES_ENV = 'OLCLI_MCP_UNCONFIRMED_WRITES';

/**
 * Decide whether writes need the user's confirmation. `1`, `true`, or `yes`
 * turns confirmation off, `0`, `false`, or `no` turns it on, unset or empty
 * keeps the default. Any other value keeps confirmation on: a typo must not
 * silently remove the check.
 */
export function writesNeedConfirmation(env: NodeJS.ProcessEnv): boolean {
  const raw = env[UNCONFIRMED_WRITES_ENV];
  if (raw === undefined || raw.trim() === '') return CONFIRM_WRITES_BY_DEFAULT;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') return false;
  return true;
}

/**
 * The form the user fills in: one boolean. It starts unchecked, so submitting
 * the form without checking it confirms nothing.
 */
export const CONFIRM_SCHEMA = {
  type: 'object' as const,
  properties: {
    confirm: {
      type: 'boolean' as const,
      title: 'Confirm',
      description: 'Check to let olcli make this change in Overleaf',
      default: false
    }
  },
  required: ['confirm']
};

/**
 * How long the server waits for the user to answer. The SDK default of 60
 * seconds is short for reading a diff; the tool call is canceled sooner if
 * the client cancels it.
 */
export const CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Closes every dialog, so the user knows who asks and what a yes does. */
export const DIALOG_FOOTER = 'An AI assistant asked olcli to make this change through MCP. Nothing is written unless you check "Confirm" and accept.';

/** Lines of a diff shown per document before the rest is cut. */
export const MAX_DIFF_LINES = 60;
/** Diff lines shown across all documents of one dialog. */
export const MAX_DIFF_LINES_TOTAL = 200;
/** Documents whose diff is shown before the rest is cut. */
export const MAX_DIFF_DOCS = 10;
/** Files larger than this are not downloaded and diffed for an upload preview. */
export const MAX_DIFF_BYTES = 1024 * 1024;
/** Lines of comment text shown before the rest is cut. */
export const MAX_TEXT_LINES = 40;
/** Tracked changes listed before the rest is cut. */
export const MAX_LISTED_CHANGES = 25;
/** Characters per line before the rest of the line is cut. */
export const MAX_LINE_CHARS = 240;
/** Characters of a quoted inline value (a tracked change, a name). */
export const MAX_INLINE_CHARS = 200;

function isInvisible(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a)
    || (code >= 0x7f && code <= 0x9f)
    || code === 0xad
    || code === 0x061c
    || code === 0x180e
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x2028 && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2069)
    || code === 0xfeff;
}

/**
 * Make control, zero-width, and bidirectional formatting characters visible
 * as `\u{...}`. Text in the dialog comes from collaborators; a right-to-left
 * override or a zero-width character could otherwise make it read
 * differently from what is written.
 */
export function revealInvisible(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += isInvisible(code) ? `\\u{${code.toString(16)}}` : ch;
  }
  return out;
}

/**
 * A value that must stay on one line, such as a path or a name: invisible
 * characters revealed, line breaks and tabs escaped, length capped.
 */
export function inlineText(text: string, max = MAX_INLINE_CHARS): string {
  return truncateChars(revealInvisible(text).replace(/\n/g, '\\n').replace(/\t/g, '\\t'), max);
}

/** Cut a single line after `max` characters, saying how many were cut. */
export function truncateChars(text: string, max = MAX_LINE_CHARS): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const hidden = chars.length - max;
  return `${chars.slice(0, max).join('')} ... ${hidden} more character${hidden === 1 ? '' : 's'} not shown`;
}

/**
 * Keep the first `maxLines` lines, each cut to `maxChars`, and end with
 * `... N more lines not shown` when anything was dropped.
 */
export function truncateLines(text: string, maxLines: number, maxChars = MAX_LINE_CHARS): string {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, maxLines).map(line => truncateChars(line, maxChars));
  const hidden = lines.length - shown.length;
  if (hidden > 0) shown.push(`... ${hidden} more line${hidden === 1 ? '' : 's'} not shown`);
  return shown.join('\n');
}

/** A value on one line, quoted, with invisible characters revealed and a length cap. */
export function quoteInline(text: string, max = MAX_INLINE_CHARS): string {
  const chars = [...text];
  const shown = chars.length > max ? chars.slice(0, max).join('') : text;
  const hidden = chars.length - [...shown].length;
  const quoted = revealInvisible(JSON.stringify(shown));
  return hidden > 0 ? `${quoted} ... ${hidden} more character${hidden === 1 ? '' : 's'} not shown` : quoted;
}

/**
 * A fenced block for multi-line text. The fence is longer than any backtick
 * run inside, so the content cannot close it early when the client renders
 * Markdown; clients that show plain text show the fence as is.
 */
export function fenced(text: string, info = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** Multi-line text for the dialog: invisible characters revealed, cut to `maxLines`. */
export function textBlock(text: string, maxLines = MAX_TEXT_LINES, info = ''): string {
  return fenced(truncateLines(revealInvisible(text), maxLines), info);
}

/** A unified diff for the dialog, without jsdiff's `====` separator line. */
export function diffBlock(diff: string, maxLines = MAX_DIFF_LINES): string {
  return textBlock(diff.replace(/^=+\n/, ''), maxLines, 'diff');
}

/** One line per tracked change, in document order: location, kind, author, text. */
export function formatChangeList(changes: TrackedChange[], max = MAX_LISTED_CHANGES): string {
  const ordered = [...changes].sort((a, b) => a.path.localeCompare(b.path) || a.position - b.position);
  const lines = ordered.slice(0, max).map(change => {
    const when = change.timestamp ? ` (${change.timestamp})` : '';
    return `- ${inlineText(change.path)}:${change.line}:${change.column} ${change.kind} by ${inlineText(formatAuthor(change.author))}${when}: ${quoteInline(change.text)}`;
  });
  const hidden = changes.length - lines.length;
  if (hidden > 0) lines.push(`... ${hidden} more change${hidden === 1 ? '' : 's'} not shown`);
  return lines.join('\n');
}

/**
 * Diffs of several documents for one dialog. Each document shows at most
 * `MAX_DIFF_LINES` lines and all of them together at most
 * `MAX_DIFF_LINES_TOTAL`, so a large selection cannot make the dialog
 * unreadable. A document without a diff shows its `note` instead; `remark`
 * is printed under the heading.
 */
export function diffBlocks(docs: Array<{ path: string; diff: string | null; note?: string; remark?: string }>, heading: (path: string) => string): string {
  const parts: string[] = [];
  let budget = MAX_DIFF_LINES_TOTAL;
  let shown = 0;
  for (const doc of docs) {
    if (shown >= MAX_DIFF_DOCS || budget <= 0) break;
    const title = heading(inlineText(doc.path)) + (doc.remark ? `\n${doc.remark}` : '');
    if (doc.diff === null) {
      parts.push(`${title}\n${doc.note ?? 'No diff available.'}`);
    } else {
      const limit = Math.min(MAX_DIFF_LINES, budget);
      parts.push(`${title}\n${diffBlock(doc.diff, limit)}`);
      budget -= limit;
    }
    shown += 1;
  }
  const hidden = docs.length - shown;
  if (hidden > 0) parts.push(`... ${hidden} more document${hidden === 1 ? '' : 's'} not shown`);
  return parts.join('\n\n');
}

/** `"Name" (id)` when the name is known, else the id. */
export function projectLabel(projectId: string, name?: string): string {
  return name ? `${quoteInline(name)} (${inlineText(projectId)})` : inlineText(projectId);
}

export function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} byte${bytes === 1 ? '' : 's'}`;
}

/** Pluralize a count: `2 tracked changes`, `1 tracked change`. */
export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The text of the confirmation dialog: what will happen, then who asks. */
export function dialogMessage(preview: string): string {
  return `${preview}\n\n${DIALOG_FOOTER}`;
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  if (arg !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface OlcliCommand {
  /** Subcommand words, e.g. `['changes', 'accept']`. */
  command: string[];
  /** Options with a value; undefined values are left out. */
  options?: Array<[string, string | number | undefined]>;
  /** Options without a value, e.g. `--yes`. */
  flags?: string[];
  /** Positional arguments. */
  args: string[];
}

/**
 * Render an `olcli` command line a user can paste into a POSIX shell.
 * Options go first; positional arguments follow, after `--` when one of them
 * starts with a dash, and an option value starting with a dash uses the
 * `--opt=value` form, so no argument can be read as an option.
 */
export function olcliCommand(spec: OlcliCommand, env: NodeJS.ProcessEnv = {}): string {
  const parts: string[] = ['olcli'];
  // The server may run against another instance than the user's terminal.
  if (env.OVERLEAF_BASE_URL) parts.push('--base-url', env.OVERLEAF_BASE_URL);
  parts.push(...spec.command);
  for (const [flag, value] of spec.options ?? []) {
    if (value === undefined) continue;
    const text = String(value);
    if (text.startsWith('-')) parts.push(`${flag}=${text}`);
    else parts.push(flag, text);
  }
  parts.push(...(spec.flags ?? []));
  if (spec.args.some(arg => arg.startsWith('-'))) parts.push('--');
  parts.push(...spec.args);
  return parts.map(shellQuote).join(' ');
}

/**
 * Whether the client declared form-mode elicitation. The SDK reads an empty
 * `elicitation: {}` (the form of the capability before URL mode existed) as
 * form mode, and so does this check.
 */
export function supportsFormElicitation(capabilities: { elicitation?: object } | undefined): boolean {
  const elicitation = capabilities?.elicitation as Record<string, unknown> | undefined;
  if (!elicitation || typeof elicitation !== 'object') return false;
  return elicitation.form !== undefined || Object.keys(elicitation).length === 0;
}

export type ConfirmationOutcome =
  | 'declined'
  | 'canceled'
  | 'not_confirmed'
  | 'timeout'
  | 'aborted'
  | 'error'
  | 'unsupported';

/** What the agent is told when nothing was written, by outcome. */
export function outcomeMessage(outcome: ConfirmationOutcome, detail?: string): string {
  switch (outcome) {
    case 'declined':
      return 'The user declined this change. Nothing was written to Overleaf. Do not retry unless the user asks for it.';
    case 'canceled':
      return 'The user dismissed the confirmation without choosing. Nothing was written to Overleaf.';
    case 'not_confirmed':
      return 'The user submitted the confirmation without checking "Confirm". Nothing was written to Overleaf.';
    case 'timeout':
      return `The user did not answer the confirmation in time${detail ? ` (${detail})` : ''}. Nothing was written to Overleaf.`;
    case 'aborted':
      return 'The request was canceled while waiting for the user. Nothing was written to Overleaf.';
    case 'error':
      return `The confirmation could not be shown or read${detail ? `: ${detail}` : ''}. Nothing was written to Overleaf.`;
    case 'unsupported':
      return `This MCP client did not declare the elicitation capability, so olcli cannot ask the user to confirm this change. Nothing was written to Overleaf. Show the preview and cli_command to the user: they can review it and apply it by running cli_command in a terminal where olcli is signed in. Run it yourself only if the user explicitly asks you to. To let this server write without asking, relying on the MCP client's own tool approval as olcli 0.15.0 did, the user can set ${UNCONFIRMED_WRITES_ENV}=1 in the server's environment.`;
  }
}
