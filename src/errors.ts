/**
 * Typed errors and the one place that turns an error into words for a human.
 *
 * The client throws these instead of `new Error("Failed to x: 403")` so that
 * every front end (CLI, MCP server, git remote helper) can name the cause and
 * the next command without parsing message strings. The HTTP status stays on
 * the error and is printed after the hint, not instead of it.
 */

/** The command that fixes an expired or rejected session. */
export const AUTH_COMMAND = 'olcli auth';

export const SESSION_EXPIRED_HINT = `Session expired or invalid. Run: ${AUTH_COMMAND}`;

/** A non-2xx answer from Overleaf. `action` says what olcli was trying to do. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly action: string;

  constructor(action: string, status: number, detail?: string) {
    super(`${action} (HTTP ${status})${detail ? ` ${detail}` : ''}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.action = action;
  }
}

/**
 * Overleaf rejected the session: HTTP 401 or 403, a redirect to the login
 * page, or a login form where a logged-in page was expected.
 *
 * The message is the hint itself, so a front end that only prints
 * `error.message` still tells the user what to run.
 */
export class SessionExpiredError extends Error {
  readonly status?: number;
  /** What olcli was doing and what Overleaf answered, for the line after the hint. */
  readonly detail: string;

  constructor(detail: string, status?: number) {
    super(SESSION_EXPIRED_HINT);
    this.name = 'SessionExpiredError';
    this.detail = detail;
    this.status = status;
  }
}

/**
 * Overleaf refused to rename a project the signed-in account does not own.
 *
 * Overleaf lets only the owner rename a project and answers 403 to every
 * collaborator, including ones with edit access, while the session itself
 * stays valid. Reporting that as an expired session sent users to
 * `olcli auth`, which cannot help (issue #62).
 */
export class ProjectOwnerOnlyError extends Error {
  readonly status?: number;
  readonly owner?: string;

  constructor(owner?: string, status?: number) {
    super(
      owner
        ? `Only the project owner can rename a project. This project is owned by ${owner}.`
        : 'Only the project owner can rename a project.'
    );
    this.name = 'ProjectOwnerOnlyError';
    this.owner = owner;
    this.status = status;
  }
}

/** HTTP statuses that mean "this session is not allowed", not "this request is wrong". */
export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * The error to throw for a non-2xx response. 401 and 403 become a
 * SessionExpiredError; everything else keeps its status on an HttpStatusError.
 */
export function httpError(action: string, status: number, detail?: string): Error {
  if (isAuthStatus(status)) {
    return new SessionExpiredError(`HTTP ${status} while trying to: ${lowerFirst(action)}`, status);
  }
  return new HttpStatusError(action, status, detail);
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export interface FormatErrorOptions {
  /** `--verbose` is already on, so do not suggest it. */
  verbose?: boolean;
}

/**
 * Turn any error into lines for a human: the first line names the cause (and,
 * where there is one, the command that fixes it); later lines carry the HTTP
 * status and where to look next.
 */
export function formatError(error: unknown, options: FormatErrorOptions = {}): string[] {
  const verboseHint = options.verbose ? '' : ' Re-run with --verbose for the request log.';

  if (error instanceof SessionExpiredError) {
    return [error.message, `${error.detail}.${verboseHint}`];
  }

  if (error instanceof ProjectOwnerOnlyError) {
    if (error.status === undefined) return [error.message];
    return [
      error.message,
      `Overleaf answered HTTP ${error.status}. If you are the owner, your session may have expired; run: ${AUTH_COMMAND}.${verboseHint}`,
    ];
  }

  if (error instanceof HttpStatusError) {
    const status = error.status;
    let cause: string;
    if (status === 404) {
      cause = `${error.action}: not found on Overleaf. Check the project name or path; run: olcli list`;
    } else if (status === 429) {
      cause = `${error.action}: Overleaf is rate limiting requests. Wait a minute, then retry.`;
    } else if (status >= 500) {
      cause = `${error.action}: Overleaf answered with a server error. Retry later.`;
    } else {
      cause = `${error.action}.`;
    }
    return [cause, `HTTP ${status}.${verboseHint}`];
  }

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && NETWORK_CODES.has(code)) {
      return [
        `Could not reach Overleaf (${code}). Check the network, --base-url, or HTTPS_PROXY.`,
        `${error.message}.${verboseHint}`,
      ];
    }
    if (/^Request timeout after \d+ms$/.test(error.message)) {
      return [
        `${error.message}. Raise it with --timeout <ms> or OVERLEAF_TIMEOUT, or check HTTPS_PROXY.`,
      ];
    }
    return error.message.split('\n');
  }

  return [String(error)];
}

/** `formatError` as a single string, for front ends that print one message (MCP). */
export function formatErrorText(error: unknown, options: FormatErrorOptions = {}): string {
  return formatError(error, options).join('\n');
}
