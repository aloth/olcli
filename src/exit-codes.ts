/**
 * Exit statuses of the `olcli` command, and the one place that maps an error
 * to one of them.
 *
 * The table is part of the command-line contract (docs/STABILITY.md): a
 * script may branch on these numbers. `diff --exit-code` keeps the statuses
 * of diff(1) (0 same, 1 different, 2 trouble), which it documented before
 * this table existed.
 */

import { CaptchaRequiredError, SessionExpiredError } from './errors.js';
import { RejectConflictError } from './tracked-changes.js';
import { PromptCancelled } from './prompt.js';

export const EXIT = {
  /** The command did what it was asked. */
  OK: 0,
  /** Any failure without a more specific status below. */
  FAILURE: 1,
  /** The command line was wrong: unknown option, missing argument, invalid value. */
  USAGE: 2,
  /** Reserved for commands that report differences; `diff --exit-code` keeps 1, see above. */
  DIFFERENCES: 3,
  /** Not signed in, or Overleaf rejected the session. */
  AUTH: 4,
  /** The project changed in a way that makes the write unsafe; nothing was written. */
  CONFLICT: 5,
  /** Interrupted by the user (Ctrl-C). */
  INTERRUPTED: 130,
} as const;

/** A wrong command line, found after Commander accepted it (an invalid value, a missing project). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** No credential was found at all. */
export class NotSignedInError extends Error {
  constructor(message = 'Not signed in. Run: olcli auth') {
    super(message);
    this.name = 'NotSignedInError';
  }
}

/** A refused write: the project changed since the preview, or names would collide. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** The exit status for an error that ends a command. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return EXIT.USAGE;
  if (error instanceof NotSignedInError) return EXIT.AUTH;
  if (error instanceof SessionExpiredError) return EXIT.AUTH;
  if (error instanceof CaptchaRequiredError) return EXIT.AUTH;
  if (error instanceof ConflictError) return EXIT.CONFLICT;
  if (error instanceof RejectConflictError) return EXIT.CONFLICT;
  if (error instanceof PromptCancelled) return EXIT.INTERRUPTED;
  if (error instanceof Error && error.name === 'BrowserSignInAborted') return EXIT.INTERRUPTED;
  return EXIT.FAILURE;
}

/**
 * Commander's own errors: help and version asked for explicitly exit 0; every
 * parse error (unknown option or command, missing argument or value, invalid
 * choice) and help shown because the command line was incomplete, such as
 * `olcli help <unknown>` or a command group without a subcommand, is a usage
 * error.
 */
export function commanderExitCode(error: { exitCode: number; code: string }): number {
  return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
}

export const EXIT_CODES_HELP = `Exit statuses of olcli, the same for every command:

  0    success
  1    failure without a more specific status (network, Overleaf error,
       project or file not found, compile failed)
  2    usage error: unknown command or option, missing argument, invalid
       value, no project given
  3    reserved for "differences found"
  4    not signed in, or Overleaf rejected the session (run: olcli auth)
  5    conflict: the project changed since the preview, or the write would
       collide with what is there; nothing was written
  130  interrupted (Ctrl-C)

diff --exit-code keeps the statuses of diff(1): 0 when nothing differs, 1
when something does, 2 when the run failed for any reason, including a
missing or expired session.

Example:
  olcli auth status --json > /dev/null || olcli auth --browser
  olcli pull "Paper"; case $? in 4) echo "sign in again";; esac
`;

export const ENVIRONMENT_HELP = `Environment variables olcli reads. A flag wins over its variable, and the
variable over the stored config.

  OVERLEAF_SESSION        session cookie (instead of olcli auth)
  OVERLEAF_EMAIL, OVERLEAF_PASSWORD
                          password login when no session cookie works;
                          self-hosted servers without reCAPTCHA only
                          (overleaf.com: olcli auth --browser)
  OVERLEAF_BASE_URL       instance URL, like --base-url
  OVERLEAF_COOKIE_NAME    session cookie name, like --cookie-name
  OVERLEAF_TIMEOUT        HTTP timeout in milliseconds, like --timeout
  OLCLI_CONCURRENCY       documents fetched in parallel by comments list,
                          1 to 8 (default 4), like --concurrency
  OLCLI_BROWSER           browser for olcli auth --browser, when it is not
                          found in the usual places
  HTTPS_PROXY             proxy for https:// instances (CONNECT tunnel)
  HTTP_PROXY              proxy for http:// instances
  ALL_PROXY               proxy for both, when the two above are unset
  NO_PROXY                comma-separated hosts that bypass the proxy
                          (localhost and 127.0.0.1 are always direct)
  NO_COLOR                turn off color, like --no-color

The MCP server (olcli-mcp) also reads OLCLI_MCP_UNCONFIRMED_WRITES, and the
git remote helper GIT_REMOTE_OVERLEAF_DEBUG; see docs/CONFIGURATION.md.
`;

/** Topics for `olcli help <topic>`, next to the help of each command. */
export const HELP_TOPICS: Record<string, string> = {
  'exit-codes': EXIT_CODES_HELP,
  environment: ENVIRONMENT_HELP,
};
