/**
 * What `olcli auth` does when a password sign-in is refused because the
 * instance requires a captcha: on a terminal, offer the browser sign-in
 * instead; everywhere else, only report it.
 *
 * Kept apart from cli.ts so the decision can be tested without a terminal,
 * a browser or the network.
 */

import { CaptchaRequiredError } from './errors.js';

export interface BrowserFallbackDeps {
  /** True when a person is at the terminal (see `canOfferBrowserSignIn`). */
  interactive: boolean;
  /** Throws with a reason when `auth --browser` cannot run here (no browser, old Node). */
  checkBrowser: () => void;
  /** Asks the question; resolves to true for yes. */
  ask: (question: string) => Promise<boolean>;
  /** Runs the same flow as `olcli auth --browser`. */
  runBrowser: () => Promise<void>;
}

/**
 * - `browser`: the user said yes and the browser sign-in ran
 * - `declined`: the user said no
 * - `unavailable`: interactive, but `auth --browser` cannot run here; `reason` says why
 * - `not-offered`: not a captcha error, or nobody to ask
 */
export type BrowserFallbackOutcome =
  | { outcome: 'browser' }
  | { outcome: 'declined' }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'not-offered' };

export const BROWSER_FALLBACK_QUESTION = 'Sign in in the browser instead?';

/**
 * True when stdin and stdout are both terminals and no CI system is driving
 * the run. Only then can a question be answered by a person.
 */
export function canOfferBrowserSignIn(
  streams: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = { stdin: process.stdin, stdout: process.stdout },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const ci = env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI.toLowerCase() !== 'false';
  return Boolean(streams.stdin.isTTY) && Boolean(streams.stdout.isTTY) && !ci;
}

export async function offerBrowserSignIn(error: unknown, deps: BrowserFallbackDeps): Promise<BrowserFallbackOutcome> {
  if (!(error instanceof CaptchaRequiredError) || !deps.interactive) return { outcome: 'not-offered' };
  try {
    deps.checkBrowser();
  } catch (reason) {
    return { outcome: 'unavailable', reason: reason instanceof Error ? reason.message : String(reason) };
  }
  if (!(await deps.ask(BROWSER_FALLBACK_QUESTION))) return { outcome: 'declined' };
  await deps.runBrowser();
  return { outcome: 'browser' };
}

/** Hosts where password sign-in is known to need a captcha. */
const CAPTCHA_HOSTS = new Set(['www.overleaf.com', 'overleaf.com']);

/**
 * Warnings for `auth status` about the credential that would be used.
 * Password credentials on overleaf.com cannot sign in, because Overleaf
 * requires a captcha for password sign-in there. Self-hosted instances are
 * not judged: whether they have reCAPTCHA switched on is only known after a
 * sign-in attempt.
 */
export function passwordSignInWarnings(usesPassword: boolean, baseUrl: string): string[] {
  if (!usesPassword) return [];
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!CAPTCHA_HOSTS.has(host)) return [];
  return ['overleaf.com requires a captcha for password sign-in, which olcli cannot complete. Sign in with: olcli auth --browser'];
}
