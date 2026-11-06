#!/usr/bin/env node
/**
 * olcli - Overleaf Command Line Interface
 *
 * Command-line access to Overleaf projects using session cookies
 * for authentication. Download, upload, sync, and compile LaTeX projects.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { formatError } from './errors.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { OverleafClient, resolveCommentConcurrency, type TrackedChange } from './client.js';
import { formatAuthor } from './tracked-changes.js';
import { resolveRemotePath, resolveWithin, normalizeRemotePath, safeLocalName, legacyLocalName } from './paths.js';
import { planProjectRenames } from './rename-plan.js';
import { scanLocalFiles } from './scan.js';
import {
  compareTrees,
  DIFF_EXIT_FAILURE,
  differencesExitCode,
  filterRemoteTree,
  renderFileDiff,
  statusLetter,
  type FileDiff,
} from './diff.js';
import {
  DIFF_OUTPUT_DIR,
  LatexdiffError,
  RootDocumentError,
  buildLatexdiffArgs,
  diffOutputPath,
  isTexPath,
  latexdiffInstallHint,
  materializeTree,
  remoteScratchPath,
  resolveRootDocument,
  runLatexdiff,
} from './latexdiff.js';
import { loadIgnore } from './ignore.js';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const VERSION = pkg.version;
import {
  getSessionCookie,
  setSessionCookie,
  setLastProject,
  getConfigPath,
  saveOlAuth,
  clearConfig,
  getBaseUrl,
  setBaseUrl,
  getSessionCookieName,
  setSessionCookieName,
  getTimeout,
  setTimeout,
  getPasswordCredentials,
  setPasswordCredentials,
  clearOlAuth,
  inspectStoredCredentials,
  parseCookieInput,
  resolveSessionCookie,
  maskSecret,
  type PasswordCredentials
} from './config.js';
import { promptHidden, PromptCancelled, NotATerminal } from './prompt.js';

const program = new Command();

program
  .name('olcli')
  .description('Overleaf CLI - interact with Overleaf projects from the command line')
  .version(VERSION)
  .option('--base-url <url>', 'Overleaf instance base URL (overrides OVERLEAF_BASE_URL and config)')
  .option('--cookie-name <name>', 'Session cookie name (default: overleaf_session2, use overleaf.sid for older instances)')
  .option('--timeout <ms>', 'HTTP request timeout in milliseconds', parseInt)
  .option('--verbose', 'Print every HTTP request, status, and error response body to stderr')
  .addHelpText('after', `
Environment:
  OVERLEAF_SESSION        session cookie (instead of olcli auth)
  OVERLEAF_EMAIL, OVERLEAF_PASSWORD
                          password login when no session cookie works
  OVERLEAF_BASE_URL       instance URL, like --base-url
  OVERLEAF_COOKIE_NAME    session cookie name, like --cookie-name
  OVERLEAF_TIMEOUT        HTTP timeout in milliseconds, like --timeout
  OLCLI_CONCURRENCY       documents fetched in parallel by comments list
  HTTPS_PROXY             proxy for https:// instances (CONNECT tunnel)
  HTTP_PROXY              proxy for http:// instances
  NO_PROXY                comma-separated hosts that bypass the proxy
  NO_COLOR                turn off color`);

/**
 * The one way a command reports a failure: the cause (and the command that
 * fixes it) on the spinner line, details such as the HTTP status on stderr
 * after it. Exits with `code`, 1 unless the command reserves 1 for something
 * else (`diff --exit-code`).
 */
function failWith(spinner: Ora, error: unknown, code = 1): never {
  const verbose = Boolean(program.opts().verbose);
  const [first, ...rest] = formatError(error, { verbose });
  spinner.fail(first);
  for (const line of rest) console.error(chalk.dim(`  ${line}`));
  process.exit(code);
}

/** Everything on stdin, as text. Used by `auth --cookie -`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * What to run after a successful `auth`. Names a real project when there is
 * one whose name can be quoted safely, the placeholder otherwise.
 */
function nextStepCommands(projects: { name: string }[]): string[] {
  const first = projects.find((p) => p.name && !/["$`\\]/.test(p.name));
  return ['olcli list', `olcli pull "${first ? first.name : '<name>'}"`];
}

/**
 * Where `pull <project>` puts a project when no directory is given.
 *
 * Normally `safeLocalName(name)`. Up to 0.15 every non-ASCII letter became
 * "_", so a directory pulled back then has a different name; when that one
 * exists and its .olcli.json points at the same project, and the new name is
 * not taken yet, it is reused rather than downloading a second copy.
 */
function defaultProjectDir(projectId: string, name: string, cwd = '.'): string {
  const current = safeLocalName(name);
  const legacy = legacyLocalName(name);
  if (legacy === current || existsSync(join(cwd, current))) return current;
  const legacyMeta = join(cwd, legacy, '.olcli.json');
  if (existsSync(legacyMeta)) {
    try {
      if (JSON.parse(readFileSync(legacyMeta, 'utf-8')).projectId === projectId) return legacy;
    } catch {
      // Unreadable metadata: not provably ours, use the new name.
    }
  }
  return current;
}

/**
 * Helper to get authenticated client
 *
 * `failureCode` is the status when no credential is found at all. It is 1 for
 * every command except `diff --exit-code`, which reserves 1 for "something
 * differs" and reports a run that could not start as 2.
 */
async function getClient(cookieOpt?: string, baseUrlOpt?: string, failureCode = 1): Promise<OverleafClient> {
  const baseUrl = baseUrlOpt || (program.opts().baseUrl as string | undefined) || getBaseUrl();
  const cookieName = (program.opts().cookieName as string | undefined) || getSessionCookieName();
  const cookie = cookieOpt || getSessionCookie();
  const passwordCredentials = cookieOpt ? undefined : getPasswordCredentials();

  if (cookie) {
    try {
      const client = await OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
      if (program.opts().verbose) client.setVerbose(true);
      const timeout = (program.opts().timeout as number | undefined) || getTimeout();
      client.setGlobalTimeout(timeout);
      return client;
    } catch (error) {
      if (!passwordCredentials) throw error;
    }
  }

  if (passwordCredentials) {
    return loginWithSavedPassword(passwordCredentials, baseUrl, cookieName);
  }

  console.error(chalk.red('No session cookie or password credentials found.'));
  console.error('Sign in with: olcli auth --cookie   (prompts for the cookie; see olcli auth --help)');
  console.error('Or set the OVERLEAF_SESSION environment variable.');
  process.exit(failureCode);
}

async function loginWithSavedPassword(
  credentials: PasswordCredentials,
  baseUrl: string,
  cookieName: string
): Promise<OverleafClient> {
  const client = await OverleafClient.fromPasswordLogin(credentials.email, credentials.password, baseUrl);
  persistClientSession(client, cookieName);
  if (program.opts().verbose) client.setVerbose(true);
  const timeout = (program.opts().timeout as number | undefined) || getTimeout();
  client.setGlobalTimeout(timeout);
  return client;
}

function persistClientSession(client: OverleafClient, preferredCookieName: string): void {
  const sessionCookie = client.getSessionCookiePair(preferredCookieName);
  if (!sessionCookie) {
    throw new Error('Password login succeeded, but no session cookie was returned.');
  }
  setSessionCookieName(sessionCookie.name);
  setSessionCookie(sessionCookie.value);
}

/**
 * Resolve project from argument or .olcli.json in current directory
 */
interface ResolvedProject {
  id: string;
  name: string;
}

async function resolveProject(
  client: OverleafClient,
  projectArg?: string,
  dir: string = '.'
): Promise<ResolvedProject> {
  // If project argument provided, use it
  if (projectArg) {
    // If it looks like a valid MongoDB ObjectId (24 hex chars), trust it directly
    if (/^[a-f0-9]{24}$/i.test(projectArg)) {
      // Trust the ID, use a placeholder name (will be overwritten on next list)
      return { id: projectArg, name: projectArg };
    }
    
    // Otherwise, look up by name
    const proj = await client.findProject(projectArg);
    return { id: proj.id, name: proj.name };
  }

  // Otherwise, check for .olcli.json
  const metaPath = join(dir, '.olcli.json');
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    if (meta.projectId && meta.projectName) {
      return { id: meta.projectId, name: meta.projectName };
    }
  }

  // No project found
  throw new Error('No project specified. Provide a project name/ID or run from a synced directory.');
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

const authCmd = program
  .command('auth')
  .description('Authenticate with Overleaf using a session cookie or email/password')
  .option('--cookie [session]', 'Session cookie; omit the value to be prompted, "-" reads stdin')
  .option('--email <email>', 'Account email for password login')
  .option('--password <password>', 'Account password (omit to be prompted; see warning below)')
  .option('--save-password', 'Persist the password in the config file, in plaintext')
  .option('--no-save-password', 'Do not persist the password (the default; kept for existing scripts)')
  .option('--save-local', 'Save to .olauth in current directory')
  .addHelpText('after', `
Get your session cookie: sign in to Overleaf in a browser, open the developer
tools (F12), then Application (Chrome, Edge) or Storage (Firefox), Cookies,
and copy the value of overleaf_session2 (overleaf.sid on older self-hosted
instances). Then either:
  olcli auth --cookie                       prompts, input stays hidden
  pbpaste | olcli auth --cookie -           reads the cookie from stdin
A value given on the command line works too, but lands in your shell history.

The password is not stored unless you ask for it with --save-password. A
session cookie is stored either way, and that is what later commands use; the
password only buys an automatic re-login once the cookie expires.

Passing --password puts the password in your shell history. Omit it to be
prompted instead, or set OVERLEAF_EMAIL and OVERLEAF_PASSWORD, which every
command reads without needing 'auth' at all.`)
  .action(async (options) => {
    if (!options.cookie && !options.email && !options.password) {
      console.log(chalk.yellow('To authenticate, provide a session cookie:'));
      console.log();
      console.log('1. Sign in to Overleaf in your browser');
      console.log('2. Open the developer tools (F12), then Application (Chrome, Edge) or Storage (Firefox), then Cookies');
      console.log('3. Copy the value of the cookie named "overleaf_session2"');
      console.log('4. Run this and paste it when asked (input stays hidden):');
      console.log();
      console.log(chalk.cyan('  olcli auth --cookie'));
      console.log(chalk.dim('  (or pipe it: pbpaste | olcli auth --cookie -)'));
      console.log();
      console.log('Or log in with email/password:');
      console.log(chalk.cyan('  olcli auth --email "you@example.com"'));
      console.log(chalk.dim('  (prompts for the password, so it stays out of your shell history)'));
      console.log();
      console.log('Or set OVERLEAF_SESSION environment variable');
      return;
    }

    if (options.cookie && (options.email || options.password)) {
      console.error(chalk.red('Use either --cookie or --email/--password, not both.'));
      process.exit(1);
    }

    if (!options.cookie && !options.email) {
      console.error(chalk.red('--email is required for password login.'));
      process.exit(1);
    }

    // The cookie is a secret, so it does not have to travel through argv:
    // no value prompts with hidden input, "-" reads stdin. Resolved before
    // the spinner for the same reason as the password below.
    const promptCookieName = (program.opts().cookieName as string | undefined) || getSessionCookieName();
    let cookie: string | undefined;
    if (options.cookie === true) {
      try {
        cookie = parseCookieInput(await promptHidden(`Paste the ${promptCookieName} cookie (input hidden): `), promptCookieName);
      } catch (error: any) {
        if (error instanceof NotATerminal) {
          console.error(chalk.red('No terminal available to prompt for the cookie.'));
          console.error('Pipe it instead: olcli auth --cookie - < cookie.txt');
          console.error('Or set OVERLEAF_SESSION, which every command reads.');
          process.exit(1);
        }
        if (error instanceof PromptCancelled) {
          console.error(chalk.red('Cancelled.'));
          process.exit(1);
        }
        throw error;
      }
    } else if (options.cookie === '-') {
      if (process.stdin.isTTY) {
        console.error(chalk.dim('Reading the cookie from stdin; paste it, then press Ctrl+D.'));
      }
      cookie = parseCookieInput(await readStdin(), promptCookieName);
    } else if (typeof options.cookie === 'string') {
      cookie = parseCookieInput(options.cookie, promptCookieName);
      console.error(chalk.yellow('Warning: the cookie is now in your shell history.'));
      console.error(chalk.dim('  Next time run olcli auth --cookie to be prompted, or pipe it to olcli auth --cookie -'));
    }
    if (options.cookie && !cookie) {
      console.error(chalk.red('The session cookie must not be empty.'));
      process.exit(1);
    }

    // Resolve the password before the spinner starts: a prompt and a spinner
    // both own the terminal, and ora would redraw over the prompt line.
    let password: string | undefined = options.password;
    if (!options.cookie) {
      if (password) {
        console.log(chalk.yellow('⚠ --password is now in your shell history.'));
        console.log(chalk.dim('  Omit it to be prompted, or set OVERLEAF_EMAIL/OVERLEAF_PASSWORD.'));
      } else {
        try {
          password = await promptHidden(`Password for ${options.email}: `);
        } catch (error: any) {
          if (error instanceof NotATerminal) {
            console.error(chalk.red('No terminal available to prompt for a password.'));
            console.error('Set OVERLEAF_EMAIL and OVERLEAF_PASSWORD instead — every command reads them,');
            console.error("so a scripted run does not need 'olcli auth' at all.");
            process.exit(1);
          }
          if (error instanceof PromptCancelled) {
            console.error(chalk.red('Cancelled.'));
            process.exit(1);
          }
          throw error;
        }
        if (!password) {
          console.error(chalk.red('Password must not be empty.'));
          process.exit(1);
        }
      }
    }

    const spinner = ora('Verifying session...').start();
    try {
      const baseUrl = (program.opts().baseUrl as string | undefined) || getBaseUrl();
      const cookieName = (program.opts().cookieName as string | undefined) || getSessionCookieName();

      let projects: { name: string }[];
      if (cookie) {
        const client = await OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
        projects = await client.listProjects();

        setSessionCookie(cookie);

        if (options.saveLocal) {
          saveOlAuth(cookie);
          spinner.succeed(`Authenticated! Found ${projects.length} projects. Saved to .olauth`);
        } else {
          spinner.succeed(`Authenticated! Found ${projects.length} projects.`);
        }
      } else {
        spinner.text = 'Logging in with email/password...';
        const client = await OverleafClient.fromPasswordLogin(options.email, password!, baseUrl);
        projects = await client.listProjects();
        persistClientSession(client, cookieName);
        setBaseUrl(baseUrl);

        // Opt-in, not opt-out. The session cookie persisted just above is what
        // later commands actually use; the password only buys an automatic
        // re-login after that cookie expires, and it is stored in plaintext.
        // A cookie is scoped to olcli and rotates; a password is reusable
        // everywhere and cannot be revoked without changing it. See issue #50.
        const savePassword = options.savePassword === true;
        if (savePassword) {
          setPasswordCredentials(options.email, password!);
        }

        // The old message said "Password login saved." unconditionally - even
        // under --no-save-password, which had just prevented exactly that.
        spinner.succeed(`Authenticated! Found ${projects.length} projects.`);
        if (savePassword) {
          console.log(chalk.yellow('Password stored in plaintext in the config file.'));
        } else {
          console.log(chalk.dim('Session cookie stored. The password was not saved; re-run'));
          console.log(chalk.dim('olcli auth when the session expires, or use --save-password.'));
        }
      }

      console.log(chalk.dim(`Config saved to: ${getConfigPath()}`));
      console.log();
      console.log('Next steps:');
      for (const line of nextStepCommands(projects)) console.log(`  ${chalk.cyan(line)}`);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

/**
 * `auth status`: one answer to "am I set up". Replaces `whoami` (is the
 * session valid) and `check` (where do credentials come from), which both
 * stay as hidden aliases.
 *
 * Exit status 1 when no credential is found or the session is rejected, so
 * `olcli auth status || olcli auth` works. exitCode rather than exit(): the
 * report still has to reach a pipe.
 */
async function authStatus(options: { json?: boolean }): Promise<void> {
  const baseUrl = (program.opts().baseUrl as string | undefined) || getBaseUrl();
  const cookieName = (program.opts().cookieName as string | undefined) || getSessionCookieName();
  const resolved = resolveSessionCookie();
  const stored = inspectStoredCredentials();
  const password = resolved ? undefined : getPasswordCredentials();

  const sourceLabel = !resolved
    ? (password ? (stored.envPassword ? 'OVERLEAF_EMAIL/OVERLEAF_PASSWORD' : 'saved password (config file)') : 'none')
    : resolved.source === 'env' ? 'OVERLEAF_SESSION environment variable'
    : resolved.source === 'olauth' ? `.olauth (${resolved.path})`
    : `config file (${resolved.path})`;

  const report: {
    instance: string;
    account: string | null;
    credentialSource: string;
    cookieName: string;
    cookie: string | null;
    configFile: string;
    passwordStored: boolean;
    signedIn: boolean;
    projects?: number;
    error?: string;
  } = {
    instance: baseUrl,
    account: null,
    credentialSource: sourceLabel,
    cookieName,
    cookie: resolved ? maskSecret(resolved.value) : null,
    configFile: getConfigPath(),
    passwordStored: stored.password,
    signedIn: false,
  };

  const print = (): void => {
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const row = (label: string, value: string): void => console.log(`  ${label.padEnd(12)} ${value}`);
    row('Instance', report.instance);
    row('Account', report.account ?? chalk.dim(report.signedIn ? 'unknown' : '-'));
    row('Credential', report.credentialSource);
    row('Cookie', report.cookie ? `${report.cookieName} = ${report.cookie}` : chalk.dim('-'));
    row('Config file', report.configFile);
    if (report.passwordStored) {
      row('Password', chalk.yellow('stored in plaintext in the config file (olcli logout removes it)'));
    }
    if (report.signedIn) {
      row('Session', chalk.green(`valid, ${report.projects} project(s)`));
    }
  };

  let failure: unknown;
  if (!resolved && !password) {
    report.error = 'Not signed in';
  } else {
    const spinner = options.json ? null : ora('Checking session...').start();
    try {
      const client = resolved
        ? await OverleafClient.fromSessionCookie(resolved.value, baseUrl, cookieName)
        : await OverleafClient.fromPasswordLogin(password!.email, password!.password, baseUrl);
      const timeout = (program.opts().timeout as number | undefined) || getTimeout();
      client.setGlobalTimeout(timeout);
      const projects = await client.listProjects();
      report.signedIn = true;
      report.projects = projects.length;
      report.account = client.accountEmail ?? (password ? password.email : null);
      spinner?.stop();
    } catch (error) {
      spinner?.stop();
      failure = error;
      report.error = formatError(error, { verbose: true })[0];
    }
  }

  print();

  if (!report.signedIn) {
    process.exitCode = 1;
    if (options.json) return;
    console.log();
    if (!resolved && !password) {
      console.log(chalk.yellow('Not signed in.'));
      console.log(`Run: ${chalk.cyan('olcli auth')}`);
    } else {
      const [first, ...rest] = formatError(failure, { verbose: Boolean(program.opts().verbose) });
      console.error(chalk.red(first));
      for (const line of rest) console.error(chalk.dim(`  ${line}`));
    }
  }
}

/** Hidden alias for a command folded into `auth status`. */
function deprecatedAlias(name: string, description: string): void {
  program
    .command(name, { hidden: true })
    .description(description)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      console.error(chalk.dim(`'olcli ${name}' is now 'olcli auth status'.`));
      await authStatus(options);
    });
}

authCmd
  .command('status')
  .description('Show instance, account, credential source and a masked cookie')
  .option('--json', 'Output as JSON')
  .addHelpText('after', `
Exits 1 when no credential is found or Overleaf rejects the session, so
'olcli auth status || olcli auth' signs in only when needed. The cookie is
shown masked: its last four characters and its length.

Credential sources, first match wins:
  1. OVERLEAF_SESSION environment variable
  2. .olauth file in the current directory
  3. Global config file
  4. OVERLEAF_EMAIL/OVERLEAF_PASSWORD, or a password saved with --save-password`)
  .action(authStatus);

deprecatedAlias('whoami', 'Alias of: auth status');

program
  .command('logout')
  .description('Clear stored credentials')
  .addHelpText('after', `
Clears the global config and the .olauth file in the current directory, and
reports each one separately. Environment variables cannot be cleared by a
child process, so OVERLEAF_SESSION and OVERLEAF_EMAIL/OVERLEAF_PASSWORD are
reported instead of silently ignored - both take precedence over anything on
disk.`)
  .action(() => {
    // Read before clearing: afterwards there is nothing left to report on.
    const before = inspectStoredCredentials();

    clearConfig();
    const removedOlAuth = clearOlAuth();

    const cleared: string[] = [];
    if (before.sessionCookie) cleared.push('session cookie (global config)');
    if (before.password) cleared.push('saved password (global config)');
    if (removedOlAuth) cleared.push(removedOlAuth);

    if (cleared.length === 0) {
      console.log('Nothing stored to clear.');
    } else {
      console.log(chalk.green('Cleared:'));
      for (const item of cleared) console.log(`  ${item}`);
    }

    // The reason this command was wrong before: it announced success while a
    // higher-precedence source kept the user authenticated. Anything olcli
    // cannot clear has to be said out loud, or the message is a lie again.
    if (before.envSession || before.envPassword) {
      console.log();
      console.log(chalk.yellow('Still authenticated in this shell:'));
      if (before.envSession) console.log('  OVERLEAF_SESSION is set');
      if (before.envPassword) console.log('  OVERLEAF_EMAIL and OVERLEAF_PASSWORD are set');
      console.log(chalk.dim('  These outrank anything on disk. Unset them to finish logging out.'));
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('list')
  .alias('ls')
  .description('List all projects')
  .option('--json', 'Output as JSON')
  .option('-n, --limit <n>', 'Limit number of results', parseInt)
  .option('--cookie <session>', 'Session cookie override')
  .action(async (options) => {
    const spinner = ora('Fetching projects...').start();
    try {
      const client = await getClient(options.cookie);
      let projects = await client.listProjects();

      if (options.limit) {
        projects = projects.slice(0, options.limit);
      }

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }

      if (projects.length === 0) {
        console.log(chalk.yellow('No projects found'));
        return;
      }

      console.log(chalk.bold(`Found ${projects.length} project(s):\n`));
      for (const p of projects) {
        const date = new Date(p.lastUpdated).toLocaleDateString();
        console.log(`  ${chalk.cyan(p.id)} - ${chalk.bold(p.name)}`);
        console.log(`    ${chalk.dim(`Last updated: ${date}`)}`);
      }
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('info [project]')
  .description('Show project details (by name or ID)')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Fetching project info...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      // Get entities (works without parsing HTML)
      const entities = await client.getEntities(proj.id);
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify({ project: proj, entities }, null, 2));
        return;
      }

      console.log(chalk.bold(`Project: ${proj.name}`));
      console.log(`  ID: ${chalk.cyan(proj.id)}`);
      console.log();

      // Print file list grouped by folder
      console.log(chalk.bold('Files:'));
      
      // Sort entities by path for nice display
      const sorted = entities.sort((a, b) => a.path.localeCompare(b.path));
      
      for (const entity of sorted) {
        const icon = entity.type === 'doc' ? '📄' : '📎';
        console.log(`  ${icon} ${entity.path}`);
      }

      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

const commentsCmd = program
  .command('comments')
  .description('View and manage Overleaf comments');

function printCommentContext(comment: any): void {
  if (!comment.context) return;

  const ctx = comment.context;
  let lineNumber = ctx.startLine;
  for (const line of ctx.before) {
    console.log(`  ${chalk.dim(String(lineNumber).padStart(4))}  ${chalk.dim(line)}`);
    lineNumber += 1;
  }
  console.log(`  ${chalk.yellow(String(lineNumber).padStart(4))}  ${ctx.line}`);
  lineNumber += 1;
  for (const line of ctx.after) {
    console.log(`  ${chalk.dim(String(lineNumber).padStart(4))}  ${chalk.dim(line)}`);
    lineNumber += 1;
  }
}

function printTrackedChanges(changes: TrackedChange[]): void {
  if (changes.length === 0) {
    console.log(chalk.yellow('No tracked changes found\n'));
    return;
  }
  console.log(chalk.bold(`Found ${changes.length} tracked change(s):\n`));
  for (const change of changes) {
    const kind = change.kind === 'insert' ? chalk.green('insert') : chalk.red('delete');
    console.log(`${chalk.cyan(change.id)} ${kind}`);
    console.log(`  ${change.path}:${change.line}:${change.column}`);
    console.log(`  ${chalk.dim('Author:')} ${formatAuthor(change.author)}${change.timestamp ? chalk.dim(` (${change.timestamp})`) : ''}`);
    console.log(`  ${chalk.dim('Text:')} ${JSON.stringify(change.text)}`);
    printCommentContext(change);
    console.log();
  }
}

commentsCmd
  .command('list [project]')
  .description('List project comments with selected source text and location')
  .option('--status <status>', 'Filter by status: open, resolved, or all (default: all)', 'all')
  .option('--context <n>', 'Include N lines of source context around each comment', parseInt)
  .option('--concurrency <n>', 'Sockets used to fetch docs in parallel, 1-8 (default: OLCLI_CONCURRENCY or 4)')
  .option('--changes', 'Also list tracked changes (suggested insertions and deletions); with --json the output becomes { comments, changes }')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Fetching comments...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const status = String(options.status || 'all');
      if (!['all', 'open', 'resolved'].includes(status)) {
        throw new Error('--status must be one of: all, open, resolved');
      }
      const contextLines = options.context == null ? 0 : options.context;
      if (!Number.isInteger(contextLines) || contextLines < 0) {
        throw new Error('--context must be a non-negative integer');
      }
      const listOptions = {
        status: status as 'all' | 'open' | 'resolved',
        contextLines,
        concurrency: options.concurrency === undefined ? undefined : resolveCommentConcurrency(options.concurrency)
      };
      let comments;
      let changes: TrackedChange[] | undefined;
      if (options.changes) {
        ({ comments, changes } = await client.listReview(proj.id, listOptions));
      } else {
        comments = await client.listComments(proj.id, listOptions);
      }
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(changes ? { comments, changes } : comments, null, 2));
        return;
      }

      if (changes) printTrackedChanges(changes);

      if (comments.length === 0) {
        console.log(chalk.yellow('No comments found'));
        return;
      }

      console.log(chalk.bold(`Found ${comments.length} comment(s):\n`));
      for (const comment of comments) {
        const status = comment.resolved ? chalk.green('resolved') : chalk.yellow('open');
        console.log(`${chalk.cyan(comment.threadId)} ${status}`);
        console.log(`  ${comment.path}:${comment.line}:${comment.column}`);
        console.log(`  ${chalk.dim('Selected:')} ${comment.selectedText.replace(/\s+/g, ' ').trim()}`);
        printCommentContext(comment);
        for (const message of comment.messages) {
          const author = message.user?.email || message.user?.name || message.user_id || 'unknown';
          console.log(`  ${chalk.dim(author)}: ${message.content}`);
        }
        console.log();
      }

      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

commentsCmd
  .command('reply <threadId> <body> [project]')
  .description('Reply to a comment thread with a message')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (threadId, body, project, options) => {
    const spinner = ora('Posting reply...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const message = await client.postCommentMessage(proj.id, threadId, body);
      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify({ replied: true, message }, null, 2));
        return;
      }
      spinner.succeed(`Replied to ${threadId}`);
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

commentsCmd
  .command('resolve <threadId> [project]')
  .description('Resolve a comment thread')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (threadId, project, options) => {
    const spinner = ora('Resolving comment...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const comment = await client.resolveComment(proj.id, threadId);
      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify({ resolved: true, comment: { ...comment, resolved: true } }, null, 2));
        return;
      }
      spinner.succeed(`Resolved ${threadId} at ${comment.path}:${comment.line}:${comment.column}`);
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

commentsCmd
  .command('reopen <threadId> [project]')
  .description('Reopen a resolved comment thread')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (threadId, project, options) => {
    const spinner = ora('Reopening comment...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const comment = await client.reopenComment(proj.id, threadId);
      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify({ reopened: true, comment: { ...comment, resolved: false } }, null, 2));
        return;
      }
      spinner.succeed(`Reopened ${threadId} at ${comment.path}:${comment.line}:${comment.column}`);
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

commentsCmd
  .command('delete <threadId> [project]')
  .description('Permanently delete a comment thread')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (threadId, project, options) => {
    const spinner = ora('Deleting comment...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const comment = await client.deleteComment(proj.id, threadId);
      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify({ deleted: true, comment }, null, 2));
        return;
      }
      spinner.succeed(`Deleted ${threadId} from ${comment.path}:${comment.line}:${comment.column}`);
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

commentsCmd
  .command('add <file> <message> [project]')
  .description('Add a comment to selected text in a doc')
  .option('--text <text>', 'Selected source text; the first match is used by default')
  .option('--occurrence <n>', 'Use the nth match for --text', parseInt)
  .option('--position <n>', 'Zero-based character offset in the doc', parseInt)
  .option('--line <n>', 'One-based line number', parseInt)
  .option('--column <n>', 'One-based column number', parseInt)
  .option('--length <n>', 'Selection length when using --position or --line/--column', parseInt)
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (file, message, project, options) => {
    const spinner = ora('Adding comment...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const comment = await client.addComment(proj.id, {
        filePath: file,
        content: message,
        selectedText: options.text,
        position: options.position,
        line: options.line,
        column: options.column,
        length: options.length,
        occurrence: options.occurrence
      });
      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify({ added: true, comment }, null, 2));
        return;
      }
      spinner.succeed(`Added ${comment.threadId} at ${comment.path}:${comment.line}:${comment.column}`);
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

const changesCmd = program
  .command('changes')
  .description('Review Overleaf tracked changes (suggested edits). Requires a project whose owner has an Overleaf premium plan; collaborators on any plan can then use it');

changesCmd
  .command('accept <ids...>')
  .description('Accept tracked changes by id (ids from: olcli comments list --changes)')
  .option('--project <project>', 'Project name or ID (default: the project in .olcli.json in the current directory)')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (ids: string[], options) => {
    const spinner = ora('Accepting tracked changes...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, options.project);
      const accepted = await client.acceptTrackedChanges(proj.id, ids);
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(accepted, null, 2));
      } else {
        console.log(chalk.green(`Accepted ${accepted.length} tracked change(s):`));
        for (const change of accepted) {
          console.log(`  ${chalk.cyan(change.id)} ${change.kind} ${change.path}:${change.line}:${change.column} ${JSON.stringify(change.text)}`);
        }
      }
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

changesCmd
  .command('reject <ids...>')
  .description('Reject tracked changes by id: removes suggested insertions, restores suggested deletions. Shows a preview and writes nothing unless --yes is given')
  .option('--project <project>', 'Project name or ID (default: the project in .olcli.json in the current directory)')
  .option('--yes', 'Apply the rejection after showing the preview')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (ids: string[], options) => {
    const spinner = ora('Planning rejection...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, options.project);
      const plan = await client.planTrackedChangeRejection(proj.id, ids);
      spinner.stop();

      if (!options.json) {
        for (const doc of plan.docs) console.log(doc.diff);
      }
      if (!options.yes) {
        if (options.json) console.log(JSON.stringify({ applied: false, ...plan }, null, 2));
        else console.log(chalk.yellow(`Preview only: ${plan.changes.length} tracked change(s) would be rejected. Run again with --yes to apply.`));
        setLastProject(proj.id);
        return;
      }

      const applying = ora('Rejecting tracked changes...').start();
      await client.rejectTrackedChanges(proj.id, plan);
      applying.stop();
      if (options.json) console.log(JSON.stringify({ applied: true, ...plan }, null, 2));
      else console.log(chalk.green(`Rejected ${plan.changes.length} tracked change(s).`));
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('download <file> [project]')
  .description('Download a single file from project')
  .option('-o, --output <path>', 'Output path (default: same as file name)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (file, project, options) => {
    const spinner = ora('Downloading file...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      const content = await client.downloadByPath(proj.id, file);
      const outputPath = options.output || basename(file);

      writeFileSync(outputPath, content);
      spinner.succeed(`Downloaded: ${outputPath} (${(content.length / 1024).toFixed(1)} KB)`);

      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('zip [project]')
  .description('Download project as zip archive')
  .option('-o, --output <path>', 'Output path (default: <project-name>.zip)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Downloading project...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      const zip = await client.downloadProject(proj.id);
      const outputPath = options.output || `${safeLocalName(proj.name)}.zip`;

      writeFileSync(outputPath, zip);
      spinner.succeed(`Downloaded: ${outputPath} (${(zip.length / 1024).toFixed(1)} KB)`);

      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('pdf [project]')
  .description('Compile and download PDF')
  .option('-o, --output <path>', 'Output path (default: <project-name>.pdf)')
  .option('-r, --resource <path>', 'Compile this .tex file as root document (e.g. paper.tex, folder/test.tex)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Compiling project...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      spinner.text = 'Compiling...';
      const pdf = await client.downloadPdf(proj.id, undefined, options.resource);
      const outputPath = options.output || `${safeLocalName(proj.name)}.pdf`;

      writeFileSync(outputPath, pdf);
      spinner.succeed(`Downloaded PDF: ${outputPath} (${(pdf.length / 1024).toFixed(1)} KB)`);

      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('output [type]')
  .description('Download compile output files (bbl, log, aux, etc.)')
  .option('-o, --output <path>', 'Output path')
  .option('-r, --resource <path>', 'Compile this .tex file as root document (e.g. paper.tex, folder/test.tex)')
  .option('--list', 'List available output files')
  .option('--project <name>', 'Project name or ID')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (type, options) => {
    const spinner = ora('Compiling project...').start();
    try {
      const client = await getClient(options.cookie);

      // If type looks like a project name (contains spaces or is in project list), treat it as project
      let actualType = type;
      let projectArg = options.project;

      if (type && !projectArg && !['bbl', 'log', 'aux', 'blg', 'pdf', 'out', 'fls', 'fdb_latexmk', 'stderr', 'pdfxref', 'chktex'].includes(type)) {
        // Type might actually be a project name
        const projects = await client.listProjects();
        const matchedProject = projects.find(p => p.name === type || p.id === type);
        if (matchedProject) {
          projectArg = type;
          actualType = undefined;
        }
      }

      const proj = await resolveProject(client, projectArg);
      const result = await client.compileWithOutputs(proj.id, options.resource);

      if (result.status !== 'success') {
        spinner.warn(`Compilation ${result.status}, but output files may still be available${result.failureHint ?? ''}`);
      }

      if (options.list || !actualType) {
        spinner.stop();
        console.log(chalk.bold('Available output files:'));
        for (const file of result.outputFiles) {
          console.log(`  ${chalk.cyan(file.type.padEnd(12))} ${file.path}`);
        }
        console.log();
        console.log(chalk.dim('Usage: olcli output <type>'));
        console.log(chalk.dim('Example: olcli output bbl'));
        return;
      }

      // Find matching output file
      const outputFile = result.outputFiles.find(f => f.type === actualType || f.path.endsWith(`.${actualType}`));
      if (!outputFile) {
        spinner.fail(`Output file not found: ${actualType}`);
        console.log(chalk.dim('Use --list to see available files'));
        process.exit(1);
      }

      spinner.text = `Downloading ${outputFile.path}...`;
      const content = await client.downloadOutputFile(outputFile.url);
      const outputPath = options.output || outputFile.path.replace('output.', '');

      writeFileSync(outputPath, content);
      spinner.succeed(`Downloaded: ${outputPath} (${(content.length / 1024).toFixed(1)} KB)`);

      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('upload <file> [project]')
  .description('Upload a file to a project')
  .option('--to <path>', 'Destination path within the project (default: derived from <file>)')
  .option('--folder <id>', 'Target folder ID (default: root)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (file, project, options) => {
    const spinner = ora('Uploading file...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      if (!existsSync(file)) {
        spinner.fail(`File not found: ${file}`);
        process.exit(1);
      }

      const content = readFileSync(file);
      // Derive the remote path: an explicit --to wins, absolute paths collapse
      // to their basename, relative paths keep their directory part so
      // 'figures/fig01.png' still lands in the 'figures' folder. uploadFile()
      // lazy-resolves the folder tree when no folderId/tree is supplied.
      const fileName = resolveRemotePath(file, options.to);

      // Pass folder ID or null for root folder (client will compute it)
      const folderId = options.folder || null;

      const result = await client.uploadFile(proj.id, folderId, fileName, content);

      if (result.success) {
        spinner.succeed(`Uploaded: ${fileName} → "${proj.name}"`);
      } else {
        spinner.fail(`Upload failed for: ${fileName}`);
        process.exit(1);
      }

      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// DELETE / RENAME COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
// Use deleteByPath / renameByPath which resolve a path to an entity id via
// /project/<id>/entities, then call the documented delete/rename endpoints.

program
  .command('delete <file> [project]')
  .alias('rm')
  .description('Delete a file or folder from a project')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (file, project, options) => {
    const spinner = ora('Deleting file...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      await client.deleteByPath(proj.id, file);
      spinner.succeed(`Deleted: ${file}`);
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('rename <oldname> <newname> [project]')
  .alias('mv')
  .description('Rename or move a file or folder in a project')
  .option('--cookie <session>', 'Session cookie override')
  .addHelpText('after', `
The destination decides what happens:
  intro.tex             rename in place, the folder stays the same
  chapters/intro.tex    move into chapters/ and rename; missing folders are created
  chapters/             move into chapters/ and keep the name
  /  or  /intro.tex     move to the project root

Nothing is written when the destination already exists, the source is not
found, or a folder would be moved into itself or one of its subfolders.

Examples:
  olcli mv draft.tex intro.tex
  olcli mv chapters/draft.tex chapters/intro/intro.tex
  olcli mv figures/old.png archive/
  olcli mv sub/notes.txt /`)
  .action(async (oldname, newname, project, options) => {
    const spinner = ora('Renaming file...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const plan = await client.planMove(proj.id, oldname, newname);
      if (plan.noop) {
        spinner.info(`Nothing to do: ${plan.from} is already at ${plan.to}`);
        setLastProject(proj.id);
        return;
      }
      const result = await client.applyMovePlan(proj.id, plan);
      const verb = plan.move ? (plan.rename ? 'Moved and renamed' : 'Moved') : 'Renamed';
      const created = result.createdFolders.length ? ` (created ${result.createdFolders.join(', ')})` : '';
      spinner.succeed(`${verb}: ${result.from} → ${result.to || '/'}${created}`);
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT COMMANDS (rename the project itself, not files inside it)
// ─────────────────────────────────────────────────────────────────────────────

const projectCmd = program
  .command('project')
  .description('Operate on projects themselves (create, rename, bulk rename)');

projectCmd
  .command('create <name>')
  .description('Create a new project')
  .option('-t, --template <type>', 'Project template: blank or example', 'blank')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (name, options) => {
    const template = options.template as string;
    if (template !== 'blank' && template !== 'example') {
      console.error(chalk.red(`Unsupported project template: ${template}`));
      console.error('Supported templates: blank, example');
      process.exit(1);
    }

    const spinner = ora('Creating project...').start();
    try {
      const client = await getClient(options.cookie);
      const created = await client.createProject(name, { template });
      setLastProject(created.id);

      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify(created, null, 2));
        return;
      }

      spinner.succeed(`Created project: ${created.name}`);
      console.log(`  ${chalk.cyan(created.id)}`);
      console.log(`  ${chalk.cyan(created.url)}`);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

projectCmd
  .command('rename <newname> [project]')
  .description('Rename a project')
  .option('--dry-run', 'Show what would change without applying')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (newname, project, options) => {
    const spinner = ora('Renaming project...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      if (proj.name === newname) {
        spinner.info(`Project is already named "${newname}"`);
        return;
      }

      if (options.dryRun) {
        spinner.stop();
        console.log(chalk.bold('Would rename project:'));
        console.log(`  ${chalk.cyan(proj.name)} \u2192 ${chalk.cyan(newname)}  ${chalk.dim(`(${proj.id})`)}`);
        return;
      }

      await client.renameProject(proj.id, newname);
      spinner.succeed(`Renamed project: ${proj.name} \u2192 ${newname}`);
      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

projectCmd
  .command('rename-bulk')
  .description('Rename many projects at once by pattern (dry-run unless --apply)')
  .option('--match <regex>', 'Only consider projects whose name matches this regex')
  .option('--search <text>', 'Literal substring to replace in the name')
  .option('--replace <text>', 'Replacement for --search or --match (supports $1, $2 backrefs)')
  .option('--prefix <text>', 'Prepend this to the name')
  .option('--suffix <text>', 'Append this to the name')
  .option('--apply', 'Actually rename. Without this flag nothing is changed.')
  .option('--max <n>', 'Refuse to apply if more than n projects would change', parseInt)
  .option('--cookie <session>', 'Session cookie override')
  .action(async (options) => {
    // Inverted default on purpose: for a single project a dry-run flag is a
    // convenience, but a bulk rename that fires on a typo is unrecoverable
    // (Overleaf keeps no project-name history). So doing nothing is the
    // default and --apply is the deliberate act.
    const spinner = ora('Fetching projects...').start();
    try {
      const client = await getClient(options.cookie);
      const projects = await client.listProjects();

      let plan;
      try {
        plan = planProjectRenames(projects, {
          match: options.match,
          search: options.search,
          replace: options.replace,
          prefix: options.prefix,
          suffix: options.suffix,
        });
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }

      const { planned, skipped, collisions } = plan!;
      spinner.stop();

      if (planned.length === 0) {
        console.log(chalk.yellow('No project names would change.'));
        for (const s of skipped) {
          console.log(chalk.dim(`  skipped ${s.name}: ${s.reason}`));
        }
        return;
      }

      console.log(chalk.bold(`${planned.length} project(s) would be renamed:`));
      for (const p of planned) {
        console.log(`  ${chalk.cyan(p.from)} ${chalk.dim('\u2192')} ${chalk.cyan(p.to)}  ${chalk.dim(`(${p.id})`)}`);
      }
      for (const s of skipped) {
        console.log(chalk.dim(`  skipped ${s.name}: ${s.reason}`));
      }

      if (collisions.length > 0) {
        console.log();
        console.log(chalk.red(`Name collisions (${collisions.length}):`));
        for (const c of collisions) console.log(chalk.red(`  ${c}`));
        console.log(chalk.red('Refusing to apply. Overleaf allows duplicate names, so this would'));
        console.log(chalk.red('succeed silently and leave projects you cannot tell apart.'));
        process.exit(1);
      }

      if (options.max !== undefined && planned.length > options.max) {
        console.log();
        console.log(chalk.red(`Refusing to apply: ${planned.length} changes exceed --max ${options.max}.`));
        process.exit(1);
      }

      if (!options.apply) {
        console.log();
        console.log(chalk.yellow('Dry run. Nothing was changed. Re-run with --apply to rename.'));
        return;
      }

      const applySpinner = ora(`Renaming ${planned.length} project(s)...`).start();
      let renamed = 0;
      const failures: { from: string; reason: string }[] = [];
      for (const p of planned) {
        try {
          await client.renameProject(p.id, p.to);
          renamed++;
          applySpinner.text = `Renaming... (${renamed}/${planned.length})`;
        } catch (error: any) {
          // Keep going: a partial rename is recoverable by re-running, while
          // aborting midway leaves the same partial state plus no report.
          failures.push({ from: p.from, reason: error.message || String(error) });
        }
      }

      if (failures.length > 0) {
        applySpinner.warn(`Renamed ${renamed} project(s), ${failures.length} failed`);
        for (const f of failures) {
          console.log(chalk.yellow(`  ${f.from}: ${f.reason}`));
        }
      } else {
        applySpinner.succeed(`Renamed ${renamed} project(s)`);
      }
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// COMPILE COMMAND
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('compile [project]')
  .description('Compile a project (trigger PDF generation)')
  .option('-r, --resource <path>', 'Compile this .tex file as root document (e.g. paper.tex, folder/test.tex)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Compiling...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      const result = await client.compileProject(proj.id, options.resource);
      spinner.succeed(`Compiled "${proj.name}"`);
      console.log(chalk.dim(`PDF URL: ${result.pdfUrl}`));

      setLastProject(proj.id);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// SYNC COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('pull [project] [dir]')
  .description('Download project files to local directory')
  .option('--force', 'Overwrite local files even if newer')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, dir, options) => {
    let targetDir = dir || '.';
    let projectId: string | undefined;
    let projectName: string | undefined;

    // Check for existing .olcli.json if no project specified
    const metaPath = join(targetDir, '.olcli.json');
    if (!project && existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      projectId = meta.projectId;
      projectName = meta.projectName;
    } else if (!project) {
      console.error(chalk.red('No project specified.'));
      console.error('Usage: olcli pull <project> [dir]');
      console.error('Or run from a directory with .olcli.json');
      process.exit(1);
    }

    const spinner = ora('Fetching project...').start();
    try {
      const client = await getClient(options.cookie);

      // Resolve project if needed
      if (!projectId) {
        const proj = await client.findProject(project!);
        projectId = proj.id;
        projectName = proj.name;
        // Default directory is the project name, made safe for a path
        if (!dir) {
          targetDir = defaultProjectDir(proj.id, proj.name);
          if (targetDir === legacyLocalName(proj.name) && targetDir !== safeLocalName(proj.name)) {
            spinner.info(`Using existing directory ${targetDir}/ (created by an earlier olcli)`);
            spinner.start('Downloading project...');
          }
        }
      }

      spinner.text = 'Downloading project...';
      const zipBuffer = await client.downloadProject(projectId);

      // Extract zip
      spinner.text = 'Extracting files...';
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(zipBuffer);

      // Create target directory
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      // Get local file modification times for safety check
      const { statSync } = await import('node:fs');
      const localMetaPath = join(targetDir, '.olcli.json');
      let lastPull: Date | undefined;
      if (existsSync(localMetaPath)) {
        const meta = JSON.parse(readFileSync(localMetaPath, 'utf-8'));
        lastPull = meta.lastPull ? new Date(meta.lastPull) : undefined;
      }

      // Extract files with safety check
      const entries = zip.getEntries();
      let fileCount = 0;
      let skippedCount = 0;
      const skippedFiles: string[] = [];

      const unsafeEntries: string[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory) {
          const filePath = resolveWithin(targetDir, entry.entryName);
          if (!filePath) {
            // Entry would escape the target directory (zip-slip) - never extract
            unsafeEntries.push(entry.entryName);
            continue;
          }
          const fileDir = dirname(filePath);

          // Check if local file exists and is newer than last pull
          if (!options.force && existsSync(filePath) && lastPull) {
            try {
              const stats = statSync(filePath);
              if (stats.mtime > lastPull) {
                // Local file is newer - skip unless --force
                skippedCount++;
                skippedFiles.push(entry.entryName);
                continue;
              }
            } catch {
              // File doesn't exist or can't stat, proceed with download
            }
          }

          if (!existsSync(fileDir)) {
            mkdirSync(fileDir, { recursive: true });
          }
          writeFileSync(filePath, entry.getData());
          fileCount++;
        }
      }

      if (unsafeEntries.length > 0) {
        console.log(chalk.yellow(`  Skipped ${unsafeEntries.length} unsafe archive entr${unsafeEntries.length === 1 ? 'y' : 'ies'} (path escapes target directory):`));
        for (const name of unsafeEntries.slice(0, 5)) {
          console.log(chalk.dim(`    ${name}`));
        }
      }

      // Save project metadata (with manifest of remote files for sync deletion tracking)
      const remoteManifest: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory && resolveWithin(targetDir, e.entryName)) {
          remoteManifest.push(e.entryName);
        }
      }
      writeFileSync(join(targetDir, '.olcli.json'), JSON.stringify({
        projectId,
        projectName,
        lastPull: new Date().toISOString(),
        remoteManifest
      }, null, 2));

      if (skippedCount > 0) {
        spinner.warn(`Downloaded ${fileCount} files, skipped ${skippedCount} locally modified files`);
        console.log(chalk.yellow('  Skipped (local is newer):'));
        for (const f of skippedFiles.slice(0, 5)) {
          console.log(chalk.dim(`    ${f}`));
        }
        if (skippedFiles.length > 5) {
          console.log(chalk.dim(`    ... and ${skippedFiles.length - 5} more`));
        }
        console.log(chalk.dim('  Use --force to overwrite'));
      } else {
        spinner.succeed(`Downloaded ${fileCount} files to ${targetDir}/`);
      }

      setLastProject(projectId);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('push [dir]')
  .description('Upload local changes to Overleaf project')
  .option('--project <name>', 'Project name or ID (overrides .olcli.json)')
  .option('--all', 'Upload all files (not just changed)')
  .option('--delete', 'Propagate local deletions to the remote (opt-in; see docs)')
  .option('--dry-run', 'Show what would be uploaded without uploading')
  .option('--probe-folder', 'Probe for correct folder ID (use if uploads fail with folder_not_found)')
  .option('--no-default-ignore', 'Disable built-in LaTeX artifact ignore list (only .olignore applies)')
  .option('--no-ignore', 'Disable all ignore filtering (escape hatch — uploads everything)')
  .option('--show-ignored', 'Print files skipped by ignore rules')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (dir, options) => {
    const targetDir = dir || '.';
    const metaPath = join(targetDir, '.olcli.json');

    // Check for project metadata
    let projectId: string | undefined;
    let projectName: string | undefined;
    let lastPull: Date | undefined;
    let rootFolderId: string | undefined;

    let previousPushManifest: string[] = [];

    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      projectId = meta.projectId;
      projectName = meta.projectName;
      lastPull = meta.lastPull ? new Date(meta.lastPull) : undefined;
      rootFolderId = meta.rootFolderId;
      // Written by a previous push (pushManifest) or pull (remoteManifest).
      // Either is a valid baseline for "what did this directory last put there".
      if (Array.isArray(meta.pushManifest)) {
        previousPushManifest = meta.pushManifest as string[];
      } else if (Array.isArray(meta.remoteManifest)) {
        previousPushManifest = meta.remoteManifest as string[];
      }
    }

    if (options.project) {
      // Override with command line option
      projectId = undefined;
      projectName = options.project;
    }

    if (!projectId && !projectName) {
      console.error(chalk.red('No project specified.'));
      console.error('Either run from a directory with .olcli.json or use --project');
      process.exit(1);
    }

    const spinner = ora('Connecting...').start();
    try {
      const client = await getClient(options.cookie);

      // Resolve project if needed
      if (!projectId) {
        const proj = await client.findProject(projectName!);
        projectId = proj.id;
        projectName = proj.name;
      }

      spinner.text = 'Scanning files...';

      // Build ignore context (defaults + .olignore + .olignore.local)
      const ignoreCtx = loadIgnore(targetDir, {
        noDefaults: options.defaultIgnore === false,
        disableAll: options.ignore === false,
      });

      // Get list of files to upload
      const { files: localFileList, ignored: filesIgnored } = scanLocalFiles(targetDir, ignoreCtx);

      const filesToUpload: { path: string; relativePath: string }[] = [];
      // Every local file that survives ignore filtering, regardless of mtime.
      // filesToUpload is mtime-filtered and therefore useless as a deletion
      // baseline: an unchanged file would look "absent" and get deleted.
      const allLocalPaths = new Set<string>();

      for (const file of localFileList) {
        allLocalPaths.add(file.relativePath);
        // Check if file is newer than last pull (unless --all)
        if (options.all || !lastPull || file.mtime > lastPull) {
          filesToUpload.push({ path: file.path, relativePath: file.relativePath });
        }
      }

      if (options.showIgnored && filesIgnored.length > 0) {
        spinner.stop();
        console.log(chalk.bold(chalk.dim(`Ignored ${filesIgnored.length} file(s)/dir(s):`)));
        for (const p of filesIgnored) {
          console.log(chalk.dim(`  ${p}`));
        }
        spinner.start('Scanning files...');
      }

      // Deletion candidates: tracked by a previous push/pull from THIS directory,
      // gone locally now. Never derived from the remote listing - that would also
      // sweep away files someone else uploaded through the Overleaf editor.
      //
      // Skipped entirely without a baseline manifest: on a first push we cannot
      // tell "deleted locally" from "never existed here", and guessing wrong
      // destroys remote work.
      const filesToDelete: string[] = [];
      if (options.delete && previousPushManifest.length > 0) {
        for (const path of previousPushManifest) {
          if (path === 'output.pdf' || path.endsWith('/output.pdf')) continue;
          if (!allLocalPaths.has(path)) filesToDelete.push(path);
        }
      }
      const noBaseline = options.delete === true && previousPushManifest.length === 0;

      if (filesToUpload.length === 0 && filesToDelete.length === 0) {
        spinner.info('No files to upload');
        if (noBaseline) {
          console.log(chalk.dim('  --delete skipped: no manifest yet (first push from this directory)'));
        }
        return;
      }

      if (options.dryRun) {
        spinner.stop();
        if (filesToUpload.length > 0) {
          console.log(chalk.bold(`Would upload ${filesToUpload.length} file(s) to "${projectName}":`));
          for (const f of filesToUpload) {
            console.log(`  ${chalk.cyan(f.relativePath)}`);
          }
        }
        if (filesToDelete.length > 0) {
          console.log(chalk.bold(`Would delete ${filesToDelete.length} file(s) on "${projectName}":`));
          for (const p of filesToDelete) {
            console.log(`  ${chalk.red(p)}`);
          }
        }
        if (noBaseline) {
          console.log(chalk.dim('  --delete skipped: no manifest yet (first push from this directory)'));
        }
        // This list is mtime-based: a file touched but not edited is in it, and
        // a file whose bytes already match the remote is too. `olcli diff`
        // compares content instead.
        if (filesToUpload.length > 0) {
          console.log(chalk.dim('  selected by modification time — run `olcli diff` to see content changes'));
        }
        return;
      }

      // If --probe-folder is set, or if we don't have a cached rootFolderId, try probing
      if (options.probeFolder && !rootFolderId) {
        spinner.text = 'Probing for correct folder ID...';
        rootFolderId = await client.probeRootFolderId(projectId!) ?? undefined;
        if (rootFolderId) {
          // Save the discovered folder ID
          if (existsSync(metaPath)) {
            const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            meta.rootFolderId = rootFolderId;
            writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          }
          spinner.succeed(`Found root folder ID: ${rootFolderId}`);
          spinner.start(`Uploading ${filesToUpload.length} file(s)...`);
        } else {
          spinner.fail('Could not find valid root folder ID');
          console.log(chalk.yellow('Try manually specifying rootFolderId in .olcli.json'));
          process.exit(1);
        }
      }

      // Fetch folder tree once so uploads go into correct subfolders
      spinner.text = 'Resolving folder structure...';
      let folderTree = await client.getFolderTreeFromSocket(projectId!);
      if (!folderTree) {
        // Fallback: build minimal tree with just root
        const resolvedRootId = rootFolderId || await client.getRootFolderId(projectId!);
        folderTree = { '': resolvedRootId };
      }

      spinner.text = `Uploading ${filesToUpload.length} file(s)...`;

      let uploaded = 0;
      let failed = 0;
      let folderNotFoundCount = 0;

      for (const file of filesToUpload) {
        try {
          const content = readFileSync(file.path);
          await client.uploadFile(projectId!, rootFolderId || null, file.relativePath, content, folderTree);
          uploaded++;
          spinner.text = `Uploading... (${uploaded}/${filesToUpload.length})`;
        } catch (error: any) {
          console.error(chalk.yellow(`\n  Warning: Failed to upload ${file.relativePath}: ${error.message}`));
          failed++;
          if (error.message.includes('folder_not_found')) {
            folderNotFoundCount++;
          }
        }
      }

      // Deletions run after uploads: a rename arrives as add+remove, and doing
      // it in this order never leaves the remote without the file.
      let deleted = 0;
      const deleteSkipped: { path: string; reason: string }[] = [];
      if (filesToDelete.length > 0) {
        spinner.text = `Deleting ${filesToDelete.length} remote file(s)...`;
        for (const path of filesToDelete) {
          try {
            await client.deleteByPath(projectId!, path);
            deleted++;
          } catch (error: any) {
            // Already gone remotely is the common case and not an error worth
            // failing the push over.
            deleteSkipped.push({ path, reason: error.message || String(error) });
          }
        }
      }

      // Update last push time and the manifest that the next --delete reads.
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        meta.lastPush = new Date().toISOString();
        meta.pushManifest = Array.from(allLocalPaths).sort();
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }

      if (failed > 0) {
        spinner.warn(`Uploaded ${uploaded} file(s), ${failed} failed`);
        if (folderNotFoundCount > 0 && !rootFolderId) {
          console.log(chalk.yellow('  Tip: Try running with --probe-folder to find the correct folder ID'));
        }
      } else {
        spinner.succeed(`Uploaded ${uploaded} file(s) to "${projectName}"`);
      }

      if (deleted > 0) {
        console.log(chalk.dim(`  ✖ ${deleted} deleted on remote`));
      }
      if (deleteSkipped.length > 0) {
        console.log(chalk.yellow(`  ${deleteSkipped.length} deletion(s) skipped:`));
        for (const s of deleteSkipped) {
          console.log(chalk.dim(`    ${s.path}: ${s.reason}`));
        }
      }
      if (noBaseline) {
        console.log(chalk.dim('  --delete skipped: no manifest yet; next push has a baseline'));
      }

      setLastProject(projectId!);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('sync [dir]')
  .description('Pull then push (bidirectional sync, propagates local deletions)')
  .option('--project <name>', 'Project name or ID')
  .option('--no-delete', 'Do not propagate local deletions to the remote (safer)')
  .option('--dry-run', 'Show what would change without applying')
  .option('--no-default-ignore', 'Disable built-in LaTeX artifact ignore list (only .olignore applies)')
  .option('--no-ignore', 'Disable all ignore filtering (escape hatch — uploads everything)')
  .option('--show-ignored', 'Print files skipped by ignore rules')
  .option('--cookie <session>', 'Session cookie override')
  .addHelpText('after', `
With the global --verbose, sync also lists each file it deleted on the remote,
skipped, or pushed. Combine it with --dry-run to preview deletions:
  olcli sync --dry-run --verbose`)
  .action(async (dir, options) => {
    const targetDir = dir || '.';

    // Check if this is an existing project directory
    const metaPath = join(targetDir, '.olcli.json');
    let projectId: string | undefined;
    let projectName: string | undefined;

    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      projectId = meta.projectId;
      projectName = meta.projectName;
    }

    if (options.project) {
      projectName = options.project;
      projectId = undefined;
    }

    if (!projectId && !projectName) {
      console.error(chalk.red('No project specified.'));
      console.error('Either run from a directory with .olcli.json or use --project');
      process.exit(1);
    }

    const spinner = ora('Connecting...').start();
    try {
      const client = await getClient(options.cookie);

      // Resolve project
      if (!projectId) {
        const proj = await client.findProject(projectName!);
        projectId = proj.id;
        projectName = proj.name;
      }

      // Step 1: Download current state
      spinner.text = 'Downloading project...';
      const zipBuffer = await client.downloadProject(projectId);

      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(zipBuffer);

      // Create target directory
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      // Build ignore context (defaults + .olignore + .olignore.local)
      const ignoreCtx = loadIgnore(targetDir, {
        noDefaults: options.defaultIgnore === false,
        disableAll: options.ignore === false,
      });

      // Track local modifications
      const localFiles = new Map<string, { mtime: Date; content: Buffer }>();
      let filesIgnored: string[] = [];

      // Read local files before overwriting
      if (existsSync(targetDir) && existsSync(metaPath)) {
        const scan = scanLocalFiles(targetDir, ignoreCtx);
        filesIgnored = scan.ignored;
        for (const file of scan.files) {
          localFiles.set(file.relativePath, {
            mtime: file.mtime,
            content: readFileSync(file.path)
          });
        }
      }

      if (options.showIgnored && filesIgnored.length > 0) {
        spinner.stop();
        console.log(chalk.bold(chalk.dim(`Ignored ${filesIgnored.length} local file(s)/dir(s):`)));
        for (const p of filesIgnored) {
          console.log(chalk.dim(`  ${p}`));
        }
        spinner.start();
      }

      // Extract remote files (skipping entries that would escape the target
      // directory - zip-slip protection)
      const remoteFiles = new Map<string, Buffer>();
      const unsafeRemoteEntries: string[] = [];
      for (const entry of zip.getEntries()) {
        if (!entry.isDirectory) {
          if (!resolveWithin(targetDir, entry.entryName)) {
            unsafeRemoteEntries.push(entry.entryName);
            continue;
          }
          remoteFiles.set(entry.entryName, entry.getData());
        }
      }
      if (unsafeRemoteEntries.length > 0) {
        spinner.warn(`Skipped ${unsafeRemoteEntries.length} unsafe archive entr${unsafeRemoteEntries.length === 1 ? 'y' : 'ies'} (path escapes target directory)`);
        spinner.start();
      }

      // Merge: local changes take precedence for files modified after last pull
      let lastPull: Date | undefined;
      let previousManifest: string[] = [];
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        lastPull = meta.lastPull ? new Date(meta.lastPull) : undefined;
        if (Array.isArray(meta.remoteManifest)) {
          previousManifest = meta.remoteManifest as string[];
        }
      }

      const filesToUpload: { path: string; content: Buffer }[] = [];
      const filesUpdatedLocally: string[] = [];
      const filesKeptLocal: string[] = [];
      const filesNewLocal: string[] = [];
      const filesDeletedRemote: string[] = [];
      const filesDeleteSkipped: { path: string; reason: string }[] = [];

      // Detect locally-deleted files: present in previous manifest, missing locally,
      // still present on the remote. Propagate the deletion to the remote BEFORE
      // we write remote contents back over the working tree (otherwise the file
      // would be silently restored — the bug reported in #7).
      // Conflict policy: if the project has no previous manifest yet (first sync),
      // we cannot distinguish "never existed locally" from "deleted locally", so
      // skip deletion propagation on the very first sync.
      if (options.delete !== false && previousManifest.length > 0 && existsSync(metaPath)) {
        const locallyDeleted: string[] = [];
        for (const path of previousManifest) {
          if (path === 'output.pdf' || path.endsWith('/output.pdf')) continue;
          if (!localFiles.has(path) && remoteFiles.has(path)) {
            locallyDeleted.push(path);
          }
        }

        if (locallyDeleted.length > 0) {
          spinner.text = `Propagating ${locallyDeleted.length} local deletion(s) to remote...`;
          for (const path of locallyDeleted) {
            if (options.dryRun) {
              filesDeletedRemote.push(path);
              remoteFiles.delete(path);
              continue;
            }
            try {
              await client.deleteByPath(projectId, path);
              filesDeletedRemote.push(path);
              // Drop from remoteFiles so we don't re-extract it below
              remoteFiles.delete(path);
            } catch (err: any) {
              filesDeleteSkipped.push({ path, reason: err.message || String(err) });
            }
          }
        }
      }

      spinner.text = 'Comparing files...';

      // Write remote files, but preserve local modifications
      for (const [path, remoteContent] of remoteFiles) {
        const filePath = resolveWithin(targetDir, path);
        if (!filePath) continue; // already filtered above; defense in depth
        const fileDir = dirname(filePath);
        if (!existsSync(fileDir)) {
          mkdirSync(fileDir, { recursive: true });
        }

        const localFile = localFiles.get(path);
        if (localFile && lastPull && localFile.mtime > lastPull) {
          // Local file was modified after last pull - keep local, queue for upload if different
          if (!localFile.content.equals(remoteContent)) {
            filesToUpload.push({ path, content: localFile.content });
            filesKeptLocal.push(path);
          }
          // Don't overwrite local file
        } else {
          // Write remote version
          writeFileSync(filePath, remoteContent);
          filesUpdatedLocally.push(path);
        }
      }

      // Check for new local files (not in remote)
      for (const [path, localFile] of localFiles) {
        if (path === 'output.pdf' || path.endsWith('/output.pdf')) {
          continue;
        }
        if (!remoteFiles.has(path)) {
          filesToUpload.push({ path, content: localFile.content });
          filesNewLocal.push(path);
        }
      }

      // Upload local changes
      if (filesToUpload.length > 0 && !options.dryRun) {
        spinner.text = `Uploading ${filesToUpload.length} local change(s)...`;
        for (const file of filesToUpload) {
          await client.uploadFile(projectId, null, file.path, file.content);
        }
      }

      // Refresh manifest of remote files post-sync (deletions out, new uploads in)
      const newManifest = new Set<string>(remoteFiles.keys());
      for (const f of filesToUpload) newManifest.add(f.path);
      for (const p of filesDeletedRemote) newManifest.delete(p);

      // Update metadata
      if (!options.dryRun) {
        writeFileSync(metaPath, JSON.stringify({
          projectId,
          projectName,
          lastPull: new Date().toISOString(),
          lastSync: new Date().toISOString(),
          remoteManifest: Array.from(newManifest).sort()
        }, null, 2));
      }

      if (options.dryRun) {
        spinner.succeed(`Dry-run sync "${projectName}" (no changes applied)`);
      } else {
        spinner.succeed(`Synced "${projectName}"`);
      }

      // Summary
      console.log(chalk.dim(`  ↓ ${filesUpdatedLocally.length} pulled from remote`));
      console.log(chalk.dim(`  ↑ ${filesToUpload.length} pushed to remote`));
      if (filesDeletedRemote.length > 0) {
        console.log(chalk.dim(`  ✖ ${filesDeletedRemote.length} deleted on remote`));
      }
      if (filesDeleteSkipped.length > 0) {
        console.log(chalk.yellow(`  ⚠ ${filesDeleteSkipped.length} deletion(s) failed (kept remote)`));
      }

      // The program-level --verbose, not a sync option: commander assigns a
      // flag declared on both levels to the program, so a local --verbose here
      // could never be set and this block never printed.
      if (program.opts().verbose) {
        if (filesDeletedRemote.length > 0) {
          console.log(chalk.red('\n  Deleted on remote (matched local deletion):'));
          for (const f of filesDeletedRemote) {
            console.log(chalk.dim(`    ${f}`));
          }
        }
        if (filesDeleteSkipped.length > 0) {
          console.log(chalk.yellow('\n  Deletion skipped (will retry on next sync):'));
          for (const { path, reason } of filesDeleteSkipped) {
            console.log(chalk.dim(`    ${path}  —  ${reason}`));
          }
        }
        if (filesKeptLocal.length > 0) {
          console.log(chalk.yellow('\n  Local changes pushed (local was newer):'));
          for (const f of filesKeptLocal) {
            console.log(chalk.dim(`    ${f}`));
          }
        }
        if (filesNewLocal.length > 0) {
          console.log(chalk.green('\n  New local files pushed:'));
          for (const f of filesNewLocal) {
            console.log(chalk.dim(`    ${f}`));
          }
        }
      }

      setLastProject(projectId);
    } catch (error: any) {
      failWith(spinner, error);
    }
  });

program
  .command('diff [project] [dir]')
  .description('Show content-level differences between local files and the remote project')
  .option('--name-only', 'List changed paths instead of printing patches')
  .option('--file <path>', 'Diff a single file')
  .option('-U, --unified <n>', 'Lines of context around each hunk (default: 3)', parseInt)
  .option('--exit-code', 'Exit 1 if anything differs, 0 if nothing does, 2 on failure (for CI)')
  .option('--latexdiff', 'Mark the revision up inside the document with latexdiff (requires latexdiff on PATH)')
  .option('--pdf', 'Compile the marked-up document on Overleaf and download the PDF (implies --latexdiff)')
  .option('--main <path>', 'Root .tex document to mark up (default: the only file declaring \\documentclass)')
  .option('-o, --output <path>', `Where to write the marked-up .tex (default: ${DIFF_OUTPUT_DIR}/<root>-diff.tex)`)
  .option('--no-flatten', 'Leave \\input/\\include in place instead of inlining them')
  .option('--latexdiff-opt <opt>', 'Pass an option straight through to latexdiff (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value])
  .option('--no-default-ignore', 'Disable built-in LaTeX artifact ignore list (only .olignore applies)')
  .option('--no-ignore', 'Disable all ignore filtering')
  .option('--cookie <session>', 'Session cookie override')
  // Commander reports an unknown option or a missing option value with status
  // 1, which under --exit-code means "something differs". Only this command's
  // own usage errors are remapped; help and version still exit 0.
  .exitOverride((error) => {
    const args = process.argv.slice(2);
    const end = args.indexOf('--');
    const exitCodeRequested = (end === -1 ? args : args.slice(0, end)).includes('--exit-code');
    process.exit(error.exitCode !== 0 && exitCodeRequested ? DIFF_EXIT_FAILURE : error.exitCode);
  })
  .addHelpText('after', `
The remote side is fetched fresh on every run, so the diff describes the
project as it is right now - which is what a subsequent push would overwrite.
It is not a comparison against the last pull. A collaborator editing between
diff and push can still change the outcome; the fetch time is printed for that
reason.

--latexdiff hands those same two sides to latexdiff and marks the revision up
inside the document instead: struck through is what a push would overwrite,
underlined is what it would upload. --pdf additionally uploads the marked-up
document to the project for one compile, downloads the PDF, and removes it
again - so a reviewable PDF needs no local TeX installation.

--exit-code makes the command a CI gate, with diff(1)'s statuses: 0 when
nothing differs, 1 when something does, and 2 when the run itself failed. The
last one matters - without it a pipeline cannot tell a changed file from an
expired session cookie. It applies to whatever was compared, so --file narrows
the gate to one file, and it reports on the project even under --latexdiff,
where the markup only covers the root document.`)
  .action(async (project, dir, options) => {
    const targetDir = dir || '.';

    // Every way this command can fail, as opposed to finding differences.
    // Under --exit-code that has to be distinguishable from status 1, or a
    // pipeline reads "could not reach Overleaf" as "the paper changed"; with
    // the flag absent it stays 1, which is what every other command exits.
    const failureCode = options.exitCode ? DIFF_EXIT_FAILURE : 1;

    if (!existsSync(targetDir)) {
      console.error(chalk.red(`Directory not found: ${targetDir}`));
      process.exit(failureCode);
    }

    // Checked before connecting: an unusable combination of flags should not
    // cost a login and a full project download first.
    const latexdiffMode = Boolean(options.latexdiff || options.pdf);
    const conflicting = [
      options.nameOnly ? '--name-only' : null,
      options.file ? '--file' : null,
      options.unified !== undefined ? '-U/--unified' : null,
    ].filter(Boolean);

    if (latexdiffMode && conflicting.length > 0) {
      console.error(chalk.red(`--latexdiff cannot be combined with ${conflicting.join(', ')}`));
      console.error('It marks up one root document; those options select and shape unified patch output.');
      process.exit(failureCode);
    }

    if (!latexdiffMode) {
      // Accepting these silently would produce a normal patch and no markup,
      // with nothing in the output saying the flag was dropped.
      const latexdiffOnly = [
        options.main ? '--main' : null,
        options.output ? '--output' : null,
        options.latexdiffOpt?.length ? '--latexdiff-opt' : null,
      ].filter(Boolean);
      if (latexdiffOnly.length > 0) {
        console.error(chalk.red(`${latexdiffOnly.join(', ')} only applies with --latexdiff`));
        process.exit(failureCode);
      }
    }

    const spinner = ora('Connecting...').start();
    try {
      const client = await getClient(options.cookie, undefined, failureCode);

      let resolved;
      try {
        resolved = await resolveProject(client, project, targetDir);
      } catch (error: any) {
        spinner.fail(error.message);
        console.error('Either run from a directory with .olcli.json or pass a project name/ID');
        process.exit(failureCode);
      }
      const { id: projectId, name: projectName } = resolved;

      // The whole project arrives as one zip in a single request - the same
      // call pull and sync already make. Fetching per-file would mean one
      // request per file and could not tell us which files differ without
      // downloading them anyway.
      spinner.text = 'Fetching remote project...';
      const zipBuffer = await client.downloadProject(projectId);
      const fetchedAt = new Date();

      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(zipBuffer);

      const ignoreCtx = loadIgnore(targetDir, {
        noDefaults: options.defaultIgnore === false,
        disableAll: options.ignore === false,
      });

      // Both sides go through the same filters; see filterRemoteTree.
      const remoteFiles = filterRemoteTree(
        zip.getEntries()
          .filter((e) => !e.isDirectory)
          .map((e) => ({ path: e.entryName, data: e.getData() })),
        ignoreCtx,
        (path) => resolveWithin(targetDir, path) !== null,
      );

      const scan = scanLocalFiles(targetDir, ignoreCtx);
      const localFiles = new Map<string, Buffer>();
      for (const file of scan.files) {
        localFiles.set(file.relativePath, readFileSync(file.path));
      }

      let entries = compareTrees(localFiles, remoteFiles).filter((e) => e.status !== 'unchanged');

      if (latexdiffMode) {
        await runLatexdiffMode({
          client,
          projectId,
          projectName,
          targetDir,
          localFiles,
          remoteFiles,
          entries,
          fetchedAt,
          failureCode,
          options,
          spinner,
        });
        setLastProject(projectId);
        // Reports on the comparison, not on the markup: a changed figure is a
        // difference in the project even though a marked-up root document
        // cannot show it. The `No .tex file differs` line above says as much.
        if (options.exitCode) process.exitCode = differencesExitCode(entries);
        return;
      }

      if (options.file) {
        const wanted = normalizeRemotePath(options.file);
        entries = entries.filter((e) => e.path === wanted);
        if (entries.length === 0) {
          spinner.info(`No differences in ${wanted}`);
          if (!localFiles.has(wanted) && !remoteFiles.has(wanted)) {
            console.log(chalk.dim('  (file is on neither side, or is filtered by an ignore rule)'));
          }
          return;
        }
      }

      spinner.stop();

      if (entries.length === 0) {
        console.log(chalk.green(`No differences — local files match "${projectName}"`));
        console.log(chalk.dim(`  remote fetched ${fetchedAt.toISOString()}`));
        return;
      }

      if (options.nameOnly) {
        for (const e of entries) {
          const colour = e.status === 'added' ? chalk.green
            : e.status === 'deleted' ? chalk.red
            : chalk.yellow;
          console.log(`${colour(statusLetter(e.status))}  ${e.path}`);
        }
      } else {
        for (const e of entries) {
          const patch = renderFileDiff(
            e,
            localFiles.get(e.path),
            remoteFiles.get(e.path),
            { context: options.unified },
          );
          patch.replace(/\n$/, '').split('\n').forEach((line, index) => {
            console.log(colourizeDiffLine(line, index, e.binary));
          });
        }
      }

      console.log();
      // With --file the summary would count only the one file asked for, which
      // reads as "this is all that differs". Report totals only for a full run.
      if (!options.file) {
        const counts = {
          added: entries.filter((e) => e.status === 'added').length,
          modified: entries.filter((e) => e.status === 'modified').length,
          deleted: entries.filter((e) => e.status === 'deleted').length,
        };
        console.log(chalk.bold(
          `${entries.length} file(s) differ from "${projectName}": ` +
          `${counts.added} added, ${counts.modified} modified, ${counts.deleted} remote-only`
        ));
        if (counts.deleted > 0) {
          console.log(chalk.dim('  remote-only files are left alone by push; use push --delete to remove them'));
        }
      }
      console.log(chalk.dim(`  a/ = remote as of ${fetchedAt.toISOString()}, b/ = local`));

      setLastProject(projectId);
      // Set rather than exited: `process.exit` drops whatever is still
      // buffered on a non-TTY stdout, and `olcli diff --exit-code > patch.txt`
      // is precisely a large patch going into a pipe. Returning lets node
      // flush and then exit with this status on its own.
      if (options.exitCode) process.exitCode = differencesExitCode(entries);
    } catch (error: any) {
      failWith(spinner, error, failureCode);
    }
  });

/**
 * `--latexdiff` / `--pdf`: mark the revision up inside the document.
 *
 * Runs on the two sides `diff` has already fetched, so the semantics are the
 * ones documented for the command - old is the remote as of this run, new is
 * the working directory - and no extra request is made to produce the markup.
 *
 * The remote side has to reach the filesystem before `latexdiff` can read it,
 * and the whole tree is written rather than the root document alone, because
 * `--flatten` resolves each `\input` relative to its own side.
 */
async function runLatexdiffMode(params: {
  client: OverleafClient;
  projectId: string;
  projectName: string;
  targetDir: string;
  localFiles: Map<string, Buffer>;
  remoteFiles: Map<string, Buffer>;
  entries: FileDiff[];
  fetchedAt: Date;
  /** What to exit with when this mode fails; 2 under --exit-code, else 1. */
  failureCode: number;
  /** Only the flags this mode reads; the rest of `diff`'s options are rejected. */
  options: {
    main?: string;
    output?: string;
    pdf?: boolean;
    flatten?: boolean;
    latexdiffOpt?: string[];
  };
  spinner: ReturnType<typeof ora>;
}): Promise<void> {
  const {
    client, projectId, projectName, targetDir,
    localFiles, remoteFiles, entries, fetchedAt, failureCode, options, spinner,
  } = params;

  let root = '';
  try {
    root = resolveRootDocument(localFiles, options.main ? normalizeRemotePath(options.main) : undefined);
  } catch (error) {
    if (!(error instanceof RootDocumentError)) throw error;
    spinner.stop();
    console.error(chalk.red(error.message));
    for (const candidate of error.candidates) {
      console.error(chalk.dim(`    ${candidate}`));
    }
    process.exit(failureCode);
  }

  // latexdiff needs two versions of the same document. A root document that
  // only exists locally has one, and diffing it against an empty file would
  // mark up the entire paper as an addition.
  if (!remoteFiles.has(root)) {
    spinner.stop();
    console.error(chalk.red(`${root} is not in "${projectName}" yet, so there is no earlier version to mark up.`));
    console.error(chalk.dim('  Push it first, or use --main to name a document that exists on both sides.'));
    process.exit(failureCode);
  }

  if (!entries.some((e) => isTexPath(e.path))) {
    spinner.info(`No .tex file differs from "${projectName}" - the markup will show no changes`);
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), 'olcli-latexdiff-'));
  const cleanupTmp = () => rmSync(tmpRoot, { recursive: true, force: true });

  try {
    spinner.start('Writing the remote side to a temporary directory...');
    materializeTree(tmpRoot, remoteFiles);

    spinner.text = `Running latexdiff on ${root}...`;
    let markup = '';
    let warnings = '';
    try {
      const result = await runLatexdiff(buildLatexdiffArgs(
        join(tmpRoot, root),
        join(targetDir, root),
        { flatten: options.flatten !== false, extra: options.latexdiffOpt },
      ));
      markup = result.markup;
      warnings = result.stderr.trim();
    } catch (error) {
      if (!(error instanceof LatexdiffError)) throw error;
      spinner.fail(error.message);
      if (error.missing) {
        console.error(chalk.dim(`  ${latexdiffInstallHint()}`));
        console.error(chalk.dim('  Everything else in olcli diff needs no external tools.'));
      } else if (error.stderr) {
        console.error(error.stderr);
      }
      cleanupTmp();
      process.exit(failureCode);
    }

    // An explicit --output is a path the user chose, so it is taken relative to
    // the current directory; the default belongs to the project directory being
    // diffed. Either way the PDF sits next to the source it was built from.
    const texPath = options.output || join(targetDir, diffOutputPath(root, 'tex'));
    const pdfPath = texPath.replace(/\.(tex|ltx)$/i, '') + '.pdf';

    mkdirSync(dirname(texPath), { recursive: true });
    writeFileSync(texPath, markup, 'utf-8');
    spinner.succeed(`Marked up ${root} (${(Buffer.byteLength(markup) / 1024).toFixed(1)} KB)`);

    if (warnings) {
      for (const line of warnings.split('\n')) {
        console.log(chalk.yellow(`  latexdiff: ${line}`));
      }
    }

    if (options.pdf) {
      await compileMarkupOnOverleaf({ client, projectId, projectName, root, markup, texPath, pdfPath, failureCode, spinner });
    }

    console.log();
    console.log(chalk.bold(`Revision of ${root} against "${projectName}"`));
    console.log(`  ${texPath}`);
    if (options.pdf) console.log(`  ${pdfPath}`);
    console.log(chalk.dim(
      `  struck through = remote as of ${fetchedAt.toISOString()}, underlined = local`,
    ));
    if (options.flatten !== false) {
      console.log(chalk.dim('  \\input/\\include were inlined; pass --no-flatten to keep them'));
    }
  } finally {
    cleanupTmp();
  }
}

/**
 * Compile a marked-up document with Overleaf's compiler and download the PDF.
 *
 * The compile endpoint takes a `rootResourcePath` that has to already exist in
 * the project - there is no way to compile a document that is not in it. So
 * the markup is uploaded, compiled, and removed again, which is a real
 * mutation of someone's project for the duration of one compile and is
 * announced before it happens.
 *
 * Three things follow from that and are not incidental:
 *
 * - The upload refuses to overwrite. If the scratch path is taken, that file
 *   belongs to the user, and clobbering it to produce a diff would be a worse
 *   outcome than not producing one.
 * - The delete runs from a `finally`, and nothing between the upload and it
 *   calls `process.exit` - that would terminate before the cleanup and leave
 *   the file on the project. Failures are collected and reported afterwards.
 * - An interrupt cannot be cleaned up after reliably, so it prints the exact
 *   command that removes the file rather than leaving it to be discovered.
 */
async function compileMarkupOnOverleaf(params: {
  client: OverleafClient;
  projectId: string;
  projectName: string;
  root: string;
  markup: string;
  texPath: string;
  pdfPath: string;
  /** What to exit with when the compile fails; 2 under --exit-code, else 1. */
  failureCode: number;
  spinner: ReturnType<typeof ora>;
}): Promise<void> {
  const { client, projectId, projectName, root, markup, texPath, pdfPath, failureCode, spinner } = params;
  const scratch = remoteScratchPath(root);

  spinner.start(`Checking ${scratch} is free...`);
  if (await client.findEntityByPath(projectId, scratch)) {
    spinner.fail(`"${projectName}" already has a file named ${scratch}`);
    console.error(chalk.dim('  --pdf uploads the marked-up document under that name for one compile and'));
    console.error(chalk.dim('  removes it again; it will not overwrite a file that is already there.'));
    console.error(chalk.dim(`  The marked-up source was still written: ${texPath}`));
    process.exit(failureCode);
  }

  spinner.stop();
  console.log(chalk.dim(`  uploading ${scratch} to "${projectName}" for one compile, then removing it`));

  const onInterrupt = () => {
    console.error(chalk.yellow(`\nInterrupted with ${scratch} still in "${projectName}".`));
    console.error(chalk.yellow(`Remove it with: olcli rm ${scratch}`));
    process.exit(130);
  };

  spinner.start('Uploading the marked-up document...');
  await client.uploadFile(projectId, null, scratch, Buffer.from(markup, 'utf-8'));
  process.once('SIGINT', onInterrupt);

  let failure: string[] | null = null;

  try {
    spinner.text = 'Compiling on Overleaf...';
    const compile = await client.compileWithOutputs(projectId, scratch);

    if (compile.status !== 'success' || !compile.pdfUrl) {
      failure = [`Overleaf reported "${compile.status}" compiling ${scratch}`];

      // The log is the only thing that explains a LaTeX failure, and it stops
      // being reachable as soon as the scratch file is removed below.
      const logFile = compile.outputFiles.find((f) => f.path === 'output.log');
      if (logFile) {
        const logPath = pdfPath.replace(/\.pdf$/, '.log');
        writeFileSync(logPath, await client.downloadOutputFile(logFile.url));
        failure.push(`  compiler log: ${logPath}`);
      }
      failure.push(`  marked-up source: ${texPath}`);
      // A .sty or .cls that only exists locally is the common one: Overleaf
      // compiles against the project, so anything the markup needs has to be
      // in the project. A missing *figure* does not fail - Overleaf draws a
      // placeholder box naming the file and reports success.
      failure.push('  A class, style or input file that exists only locally is the usual cause;');
      failure.push('  Overleaf compiles against the project, not against your working directory.');

      // A PDF from an earlier run would otherwise sit next to the log, dated
      // now by the directory listing and describing a different revision.
      rmSync(pdfPath, { force: true });
    } else {
      spinner.text = 'Downloading the PDF...';
      const pdf = await client.downloadOutputFile(compile.pdfUrl);
      writeFileSync(pdfPath, pdf);
      spinner.succeed(`Compiled ${basename(pdfPath)} (${(pdf.length / 1024).toFixed(1)} KB)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failure = [`Compiling ${scratch} failed: ${message}`, `  marked-up source: ${texPath}`];
  } finally {
    process.off('SIGINT', onInterrupt);
    spinner.start(`Removing ${scratch} from "${projectName}"...`);
    try {
      await client.deleteByPath(projectId, scratch);
      spinner.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.warn(`${scratch} is still in "${projectName}": ${message}`);
      console.error(chalk.yellow(`  remove it with: olcli rm ${scratch}`));
    }
  }

  if (failure) {
    spinner.fail(failure[0]);
    for (const line of failure.slice(1)) console.error(chalk.dim(line));
    process.exit(failureCode);
  }
}

/**
 * Colourize one line of a rendered patch. chalk already no-ops when stdout is
 * not a TTY, so this needs no flag of its own.
 *
 * The file headers are identified by position, not by prefix: a removed line
 * whose own content starts with `--` renders as `--- something` and would
 * otherwise be mistaken for the `---` header and shown as unchanged.
 */
function colourizeDiffLine(line: string, index: number, binary: boolean): string {
  if (index === 0) return chalk.bold(line);          // our `diff --olcli` header
  if (binary) return chalk.magenta(line);            // the single summary line
  if (index <= 2) return chalk.bold(line);           // `---` / `+++`
  if (line.startsWith('@@')) return chalk.cyan(line);
  if (line.startsWith('+')) return chalk.green(line);
  if (line.startsWith('-')) return chalk.red(line);
  return line;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELP
// ─────────────────────────────────────────────────────────────────────────────

const configCmd = program
  .command('config')
  .description('Manage olcli configuration');

configCmd
  .command('set-url <url>')
  .description('Set the Overleaf instance base URL')
  .action((url: string) => {
    setBaseUrl(url);
    console.log(chalk.green(`Base URL set to: ${url}`));
  });

configCmd
  .command('get-url')
  .description('Get the current Overleaf instance base URL')
  .action(() => {
    console.log(getBaseUrl());
  });

configCmd
  .command('set-cookie-name <name>')
  .description('Set the session cookie name (e.g. overleaf.sid for older instances)')
  .action((name: string) => {
    setSessionCookieName(name);
    console.log(chalk.green(`Session cookie name set to: ${name}`));
  });

configCmd
  .command('get-cookie-name')
  .description('Get the current session cookie name')
  .action(() => {
    console.log(getSessionCookieName());
  });

configCmd
  .command('set-timeout <ms>')
  .description('Set the default HTTP request timeout in milliseconds')
  .action((ms: string) => {
    const timeout = parseInt(ms, 10);
    if (isNaN(timeout)) {
      console.error(chalk.red('Invalid timeout value. Must be a number.'));
      process.exit(1);
    }
    setTimeout(timeout);
    console.log(chalk.green(`Default timeout set to: ${timeout}ms`));
  });

configCmd
  .command('get-timeout')
  .description('Get the current default HTTP request timeout')
  .action(() => {
    console.log(`${getTimeout()}ms`);
  });

program
  .command('ignored [dir]')
  .description('Show ignore patterns currently in effect for a project directory')
  .option('--no-default-ignore', 'Exclude built-in defaults from the listing')
  .option('--no-ignore', 'Show what --no-ignore would do (lists nothing)')
  .action((dir, options) => {
    const targetDir = dir || '.';
    const ctx = loadIgnore(targetDir, {
      noDefaults: options.defaultIgnore === false,
      disableAll: options.ignore === false,
    });
    if (!ctx.enabled) {
      console.log(chalk.yellow('Ignore filtering is disabled (--no-ignore).'));
      console.log(chalk.dim('Every local file would be uploaded.'));
      return;
    }
    if (ctx.sources.length === 0) {
      console.log(chalk.yellow('No ignore patterns active.'));
      console.log(chalk.dim('Built-in defaults are disabled and no .olignore file was found.'));
      return;
    }
    console.log(chalk.bold(`Ignore patterns in effect for ${targetDir}:`));
    console.log(chalk.dim('(later sources override earlier ones; ! prefix negates)'));
    for (const src of ctx.sources) {
      console.log();
      console.log(chalk.cyan(`── ${src.label} (${src.patterns.length}) ──`));
      for (const p of src.patterns) {
        console.log(`  ${p}`);
      }
    }
    console.log();
    console.log(chalk.dim(`Total: ${ctx.patterns.length} pattern(s)`));
    if (ctx.defaultsEnabled) {
      console.log(chalk.dim('Note: *.pdf is also ignored when a same-named *.tex/.ltx exists in the same folder.'));
    }
  });

deprecatedAlias('check', 'Alias of: auth status');

program.parse(process.argv);
