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

/** False when a terminal reports a width of 0 or less; an unknown width is fine. */
export function hasUsableWidth(stream: { columns?: number } = process.stderr): boolean {
  return stream.columns === undefined || stream.columns > 0;
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
  // A terminal that reports a width of 0 (a pty opened without a window size)
  // makes ora count Infinity lines to clear on every frame, which never
  // finishes. Treat it like a non-terminal: no animation, plain words.
  const animate = isInteractive(process.stderr) && hasUsableWidth(process.stderr);
  const spinner = oraFactory(animate ? { text } : { text, isEnabled: false });
  if (animate) return spinner;
  const plain = (symbol: string) => (message?: string): Ora => spinner.stopAndPersist({ symbol, text: message });
  spinner.succeed = plain('ok:');
  spinner.fail = plain('error:');
  spinner.warn = plain('warning:');
  spinner.info = plain('info:');
  return spinner;
}
