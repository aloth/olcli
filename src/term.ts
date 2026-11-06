/**
 * Terminal behavior: color, emoji and symbols only where a human is looking.
 *
 * - Color follows NO_COLOR (https://no-color.org: set and non-empty turns it
 *   off) and the global --no-color flag. chalk already turns color off when
 *   stdout is not a TTY.
 * - Spinners: ora only animates on an interactive stderr; createSpinner()
 *   also swaps its result symbols for words when stderr is not a terminal.
 * - Emoji and decorative symbols are replaced with plain text when stdout is
 *   not a TTY, so piped output stays greppable.
 */

import oraFactory, { type Ora } from 'ora';

export function colorDisabled(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return true;
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).includes('--no-color');
}

export function isInteractive(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

/** `fancy` on an interactive stdout, `plain` otherwise. */
export function icon(fancy: string, plain: string): string {
  return isInteractive() ? fancy : plain;
}

/**
 * An ora spinner that prints plain words instead of symbols when stderr (where
 * ora writes) is not a terminal, so a log or CI output reads "error: ..."
 * rather than a glyph. On a terminal it is ora unchanged.
 */
export function createSpinner(text: string): Ora {
  const spinner = oraFactory({ text });
  if (isInteractive(process.stderr)) return spinner;
  const plain = (symbol: string) => (message?: string): Ora => spinner.stopAndPersist({ symbol, text: message });
  spinner.succeed = plain('ok:');
  spinner.fail = plain('error:');
  spinner.warn = plain('warning:');
  spinner.info = plain('info:');
  return spinner;
}
