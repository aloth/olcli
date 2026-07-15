#!/usr/bin/env node
/**
 * olcli - Overleaf Command Line Interface
 *
 * Command-line access to Overleaf projects using session cookies
 * for authentication. Download, upload, sync, and compile LaTeX projects.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { OverleafClient } from './client.js';
import type { ChangeResolutionResult } from './changes/types.js';
import { serializeError } from './errors/serialize-error.js';
import {
  isExperimentalReviewEnabled,
  requireExperimentalReview,
} from './experimental.js';
import { PACKAGE_VERSION } from './version.js';
import { defaultUploadRemotePath } from './upload-path.js';
import {
  loadIgnore,
  shouldIgnore,
  buildTexSiblingSet,
  DEFAULT_IGNORE_PATTERNS,
  type IgnoreContext,
} from './ignore.js';

import {
  getSessionCookie,
  setSessionCookie,
  getLastProject,
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
  type PasswordCredentials
} from './config.js';

const program = new Command();

function failCommand(
  spinner: ReturnType<typeof ora>,
  error: unknown,
  json: boolean
): never {
  if (json) {
    spinner.stop();
    console.error(JSON.stringify({ error: serializeError(error) }, null, 2));
  } else {
    const message = error instanceof Error ? error.message : String(error);
    spinner.fail(`Failed: ${message}`);
  }
  process.exit(1);
}

program
  .name('olcli')
  .description('Overleaf CLI - interact with Overleaf projects from the command line')
  .version(PACKAGE_VERSION)
  .option('--base-url <url>', 'Overleaf instance base URL (overrides OVERLEAF_BASE_URL and config)')
  .option('--cookie-name <name>', 'Session cookie name (default: overleaf_session2, use overleaf.sid for older instances)')
  .option('--timeout <ms>', 'HTTP request timeout in milliseconds', parseInt)
  .option('--verbose', 'Print redacted HTTP request metadata to stderr')
  .option('--experimental-review', 'Enable experimental tracked-review mutations')
  .option(
    '--unsafe-protocol-logging',
    'Include raw collaboration frames in diagnostics (may expose document text; disposable projects only)'
  );

/**
 * Helper to get authenticated client
 */
async function getClient(cookieOpt?: string, baseUrlOpt?: string): Promise<OverleafClient> {
  const baseUrl = baseUrlOpt || (program.opts().baseUrl as string | undefined) || getBaseUrl();
  const cookieName = (program.opts().cookieName as string | undefined) || getSessionCookieName();
  const cookie = cookieOpt || getSessionCookie();
  const passwordCredentials = cookieOpt ? undefined : getPasswordCredentials();

  if (cookie) {
    try {
      const client = await OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
      if (program.opts().verbose || program.opts().unsafeProtocolLogging) client.setVerbose(true);
      if (program.opts().unsafeProtocolLogging) client.setUnsafeProtocolLogging(true);
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
  console.error('Set one with: olcli auth --cookie <session_cookie>');
  console.error('Or use: olcli auth --email <email> --password <password>');
  console.error('Or set OVERLEAF_SESSION environment variable');
  console.error('Or create .olauth file in current directory');
  process.exit(1);
}

async function loginWithSavedPassword(
  credentials: PasswordCredentials,
  baseUrl: string,
  cookieName: string
): Promise<OverleafClient> {
  const client = await OverleafClient.fromPasswordLogin(credentials.email, credentials.password, baseUrl);
  persistClientSession(client, cookieName);
  if (program.opts().verbose || program.opts().unsafeProtocolLogging) client.setVerbose(true);
  if (program.opts().unsafeProtocolLogging) client.setUnsafeProtocolLogging(true);
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
    let proj = await client.getProject(projectArg);
    if (!proj) {
      throw new Error(`Project not found: ${projectArg}`);
    }
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

program
  .command('auth')
  .description('Authenticate with Overleaf using a session cookie or email/password')
  .option('--cookie <session>', 'Session cookie (overleaf_session2 value)')
  .option('--email <email>', 'Account email for password login')
  .option('--password <password>', 'Account password for password login')
  .option('--no-save-password', 'Do not persist email/password credentials')
  .option('--save-local', 'Save to .olauth in current directory')
  .action(async (options) => {
    if (!options.cookie && !options.email && !options.password) {
      console.log(chalk.yellow('To authenticate, provide a session cookie:'));
      console.log();
      console.log('1. Log into overleaf.com in your browser');
      console.log('2. Open Developer Tools (F12) → Application → Cookies');
      console.log('3. Find the cookie named "overleaf_session2"');
      console.log('4. Copy its value and run:');
      console.log();
      console.log(chalk.cyan('  olcli auth --cookie "your_session_cookie_value"'));
      console.log();
      console.log('Or log in with email/password:');
      console.log(chalk.cyan('  olcli auth --email "you@example.com" --password "your_password"'));
      console.log();
      console.log('Or set OVERLEAF_SESSION environment variable');
      return;
    }

    if (options.cookie && (options.email || options.password)) {
      console.error(chalk.red('Use either --cookie or --email/--password, not both.'));
      process.exit(1);
    }

    if (!options.cookie && (!options.email || !options.password)) {
      console.error(chalk.red('Both --email and --password are required for password login.'));
      process.exit(1);
    }

    const spinner = ora('Verifying session...').start();
    try {
      const baseUrl = (program.opts().baseUrl as string | undefined) || getBaseUrl();
      const cookieName = (program.opts().cookieName as string | undefined) || getSessionCookieName();

      if (options.cookie) {
        const client = await OverleafClient.fromSessionCookie(options.cookie, baseUrl, cookieName);
        const projects = await client.listProjects();

        setSessionCookie(options.cookie);

        if (options.saveLocal) {
          saveOlAuth(options.cookie);
          spinner.succeed(`Authenticated! Found ${projects.length} projects. Saved to .olauth`);
        } else {
          spinner.succeed(`Authenticated! Found ${projects.length} projects.`);
        }
      } else {
        spinner.text = 'Logging in with email/password...';
        const client = await OverleafClient.fromPasswordLogin(options.email, options.password, baseUrl);
        const projects = await client.listProjects();
        persistClientSession(client, cookieName);
        setBaseUrl(baseUrl);
        if (options.savePassword !== false) {
          setPasswordCredentials(options.email, options.password);
        }

        spinner.succeed(`Authenticated! Found ${projects.length} projects. Password login saved.`);
      }

      console.log(chalk.dim(`Config saved to: ${getConfigPath()}`));
    } catch (error: any) {
      spinner.fail(`Authentication failed: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('whoami')
  .description('Show current authentication status')
  .action(async () => {
    const cookie = getSessionCookie();
    if (!cookie) {
      console.log(chalk.yellow('Not authenticated'));
      return;
    }

    const spinner = ora('Checking session...').start();
    try {
      const baseUrl = (program.opts().baseUrl as string | undefined) || getBaseUrl();
      const cookieName = (program.opts().cookieName as string | undefined) || getSessionCookieName();
      const client = await OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
      const projects = await client.listProjects();
      spinner.succeed(`Authenticated with access to ${projects.length} projects`);
    } catch (error: any) {
      spinner.fail(`Session invalid: ${error.message}`);
    }
  });

program
  .command('logout')
  .description('Clear stored credentials')
  .action(() => {
    clearConfig();
    console.log(chalk.green('Credentials cleared'));
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

function printFolder(folder: any, indent: string): void {
  // Print subfolders
  for (const f of folder.folders || []) {
    console.log(`${indent}📁 ${chalk.blue(f.name)}/`);
    printFolder(f, indent + '  ');
  }

  // Print docs
  for (const d of folder.docs || []) {
    console.log(`${indent}📄 ${d.name}`);
  }

  // Print files
  for (const f of folder.fileRefs || []) {
    console.log(`${indent}📎 ${f.name}`);
  }
}

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

commentsCmd
  .command('list [project]')
  .description('List project comments with selected source text and location')
  .option('--status <status>', 'Filter by status: open, resolved, or all (default: all)', 'all')
  .option('--context <n>', 'Include N lines of source context around each comment', parseInt)
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
      const comments = await client.listComments(proj.id, {
        status: status as 'all' | 'open' | 'resolved',
        contextLines
      });
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(comments, null, 2));
        return;
      }

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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// TRACKED-CHANGE COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

const changesCmd = program
  .command('changes')
  .description('Inspect and create native Overleaf tracked changes');

changesCmd
  .command('doctor [project]')
  .description('Inspect tracked-change capabilities for a document')
  .requiredOption('--file <path>', 'Document path to inspect')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Inspecting tracked-change capabilities...');
    if (!options.json) spinner.start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const capabilities = await client.getChangesCapabilities(proj.id, options.file);
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(capabilities, null, 2));
        return;
      }

      const supported = capabilities.canList ? chalk.green('supported') : chalk.red('unsupported');
      console.log(chalk.bold(`${capabilities.path}: ${supported}`));
      console.log(`  Document ID: ${chalk.cyan(capabilities.docId)}`);
      console.log(`  OT type: ${capabilities.otType}`);
      console.log(`  Permission: ${capabilities.permissionsLevel}`);
      console.log(`  Track changes feature: ${capabilities.featureAvailable ? 'available' : 'unavailable'}`);
      console.log(`  Current-user state: ${String(capabilities.trackChangesEnabledForCurrentUser)}`);
      console.log(`  Actions: list=${capabilities.canList} suggest=${capabilities.canSuggest} accept=${capabilities.canAccept} reject=${capabilities.canReject}`);
      if (capabilities.reasons.length > 0) {
        console.log(chalk.yellow('  Notes:'));
        for (const reason of capabilities.reasons) console.log(`    - ${reason}`);
      }
      setLastProject(proj.id);
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

changesCmd
  .command('list [project]')
  .description('List native Overleaf tracked changes without modifying them')
  .option('--file <path>', 'Limit results to one document')
  .option('--context <n>', 'Include N lines of source context', parseInt)
  .option('--unsafe-raw', 'Include undocumented raw range data (may expose document text)')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Fetching tracked changes...');
    if (!options.json) spinner.start();
    try {
      const contextLines = options.context == null ? 0 : options.context;
      if (!Number.isInteger(contextLines) || contextLines < 0) {
        throw new Error('--context must be a non-negative integer');
      }

      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const changes = await client.listTrackedChanges(proj.id, {
        filePath: options.file,
        contextLines,
        includeRaw: Boolean(options.unsafeRaw),
      });
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(changes, null, 2));
        return;
      }
      if (changes.length === 0) {
        console.log(chalk.yellow('No tracked changes found'));
        return;
      }

      console.log(chalk.bold(`Found ${changes.length} tracked change(s):\n`));
      for (const change of changes) {
        const kind = change.kind === 'insert' ? chalk.green('insert') : chalk.red('delete');
        console.log(`${chalk.cyan(change.id)} ${kind}`);
        console.log(`  ${change.path}:${change.line}:${change.column} (${change.otType})`);
        console.log(`  ${chalk.dim('Text:')} ${change.text.replace(/\s+/g, ' ').trim()}`);
        if (change.authorId) console.log(`  ${chalk.dim('Author ID:')} ${change.authorId}`);
        if (change.timestamp) console.log(`  ${chalk.dim('Timestamp:')} ${change.timestamp}`);
        printCommentContext(change);
        console.log();
      }
      setLastProject(proj.id);
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

changesCmd
  .command('suggest <file> [project]')
  .description('Create one targeted native tracked replacement')
  .requiredOption('--old <text>', 'Exact existing source text (empty only for an insertion)')
  .requiredOption('--new <text>', 'Proposed replacement text (empty for a deletion)')
  .option('--occurrence <n>', 'Use the nth match when --old is not unique', parseInt)
  .option('--position <n>', 'Zero-based source offset (required for an empty --old)', parseInt)
  .option('--line <n>', 'One-based line number', parseInt)
  .option('--column <n>', 'One-based column number', parseInt)
  .option('--expected-version <n>', 'Refuse unless the current document version matches', parseInt)
  .option('--expected-sha256 <hash>', 'Refuse unless the current source SHA-256 matches')
  .option('--dry-run', 'Preview the exact targeted operation without modifying Overleaf')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (file, project, options) => {
    const spinner = ora(options.dryRun ? 'Preparing suggestion preview...' : 'Submitting tracked suggestion...');
    if (!options.json) spinner.start();
    try {
      if (!options.dryRun) {
        requireExperimentalReview(
          Boolean(program.opts().experimentalReview) || isExperimentalReviewEnabled(),
          'tracked-change suggestions'
        );
      }
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const suggestion = await client.suggestTrackedChange({
        projectId: proj.id,
        filePath: file,
        oldText: options.old,
        newText: options.new,
        occurrence: options.occurrence,
        position: options.position,
        line: options.line,
        column: options.column,
        precondition: {
          expectedVersion: options.expectedVersion,
          expectedTextSha256: options.expectedSha256,
        },
        dryRun: Boolean(options.dryRun),
      });
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(suggestion, null, 2));
        return;
      }

      const isResult = 'changeIds' in suggestion;
      console.log(chalk.bold(options.dryRun ? 'Suggestion preview' : 'Tracked suggestion created'));
      console.log(`  ${suggestion.path}:${suggestion.line}:${suggestion.column}`);
      console.log(`  OT type: ${suggestion.otType}`);
      console.log(`  Version: ${suggestion.version}`);
      console.log(`  Operations: ${suggestion.operations.map(operation => operation.kind).join(', ')}`);
      console.log(`  Expected result SHA-256: ${suggestion.expectedResultSha256}`);
      if (isResult) {
        console.log(`  Change IDs: ${suggestion.changeIds.join(', ')}`);
        console.log(`  Verified: ${suggestion.verified}`);
        console.log(`  State restored: ${suggestion.trackChangesStateRestored}`);
      }
      setLastProject(proj.id);
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

function registerChangeResolutionCommand(action: 'accept' | 'reject'): void {
  const title = action === 'accept' ? 'Accept' : 'Reject';
  changesCmd
    .command(`${action} <file> <changeIds...>`)
    .description(`${title} explicit native tracked-change IDs`)
    .option('-p, --project <project>', 'Project ID or name (defaults to the current project)')
    .option('--expected-version <n>', 'Refuse unless the current document version matches', parseInt)
    .option('--expected-sha256 <hash>', 'Refuse unless the current visible source SHA-256 matches')
    .option('--dry-run', 'Preview the exact resolution without modifying Overleaf')
    .option('--json', 'Output as JSON')
    .option('--cookie <session>', 'Session cookie override')
    .action(async (file, changeIds, options) => {
      const spinner = ora(options.dryRun
        ? `Preparing ${action} preview...`
        : `${title}ing tracked changes...`);
      if (!options.json) spinner.start();
      try {
        if (!options.dryRun) {
          requireExperimentalReview(
            Boolean(program.opts().experimentalReview) || isExperimentalReviewEnabled(),
            `${action}ing tracked changes`
          );
        }
        const client = await getClient(options.cookie);
        const proj = await resolveProject(client, options.project);
        const input = {
          projectId: proj.id,
          filePath: file,
          changeIds,
          precondition: {
            expectedVersion: options.expectedVersion,
            expectedTextSha256: options.expectedSha256,
          },
          dryRun: Boolean(options.dryRun),
        };
        const resolution = action === 'accept'
          ? await client.acceptTrackedChanges(input)
          : await client.rejectTrackedChanges(input);
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(resolution, null, 2));
          return;
        }

        const result = 'remainingChangeIds' in resolution
          ? resolution as ChangeResolutionResult
          : undefined;
        console.log(chalk.bold(options.dryRun
          ? `${title} preview`
          : `Tracked changes ${action}ed`));
        console.log(`  ${resolution.path} (${resolution.otType})`);
        console.log(`  Version: ${resolution.version}`);
        console.log(`  Change IDs: ${resolution.changeIds.join(', ')}`);
        console.log(`  Transport: ${resolution.transport}`);
        console.log(`  Expected result SHA-256: ${resolution.expectedResultSha256}`);
        if (result) {
          console.log(`  After version: ${result.afterVersion}`);
          console.log(`  Verified: ${result.verified}`);
          console.log(`  Remaining changes: ${result.remainingChangeIds.length}`);
        }
        setLastProject(proj.id);
      } catch (error: unknown) {
        failCommand(spinner, error, Boolean(options.json));
      }
    });
}

registerChangeResolutionCommand('accept');
registerChangeResolutionCommand('reject');

// ─────────────────────────────────────────────────────────────────────────────
// COMMENT-TO-CHANGE REVIEW WORKFLOW
// ─────────────────────────────────────────────────────────────────────────────

const reviewCmd = program
  .command('review')
  .description('Connect comments, tracked suggestions, and a local review ledger');

reviewCmd
  .command('address <threadId> [project]')
  .description('Create a tracked suggestion for one comment and reply to its thread')
  .requiredOption('--file <path>', 'Document containing the comment')
  .requiredOption('--old <text>', 'Exact existing source text')
  .requiredOption('--new <text>', 'Proposed replacement text')
  .option('--occurrence <n>', 'Use the nth match when --old is not unique', parseInt)
  .option('--position <n>', 'Zero-based source offset for an insertion', parseInt)
  .option('--line <n>', 'One-based line number', parseInt)
  .option('--column <n>', 'One-based column number', parseInt)
  .option('--expected-version <n>', 'Refuse unless the current document version matches', parseInt)
  .option('--expected-sha256 <hash>', 'Refuse unless the current source SHA-256 matches')
  .option('--reply <message>', 'Reply text (default: concise generated summary)')
  .option('--resolve <policy>', 'Resolution policy: never, after-suggest, or after-accept', 'never')
  .option('--operation-id <uuid>', 'Stable operation ID for a safe retry')
  .option('--allow-unrelated', 'Allow an edit outside the comment selection')
  .option('--ledger <path>', 'Review ledger path (default: .olcli-review.json)')
  .option('--dry-run', 'Preview without writing the ledger or mutating Overleaf')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (threadId, project, options) => {
    const spinner = ora(options.dryRun
      ? 'Preparing review workflow preview...'
      : 'Addressing review comment...');
    if (!options.json) spinner.start();
    try {
      if (!options.dryRun) {
        requireExperimentalReview(
          Boolean(program.opts().experimentalReview) || isExperimentalReviewEnabled(),
          'comment-linked tracked suggestions'
        );
      }
      const resolutionPolicy = String(options.resolve || 'never');
      if (!['never', 'after-suggest', 'after-accept'].includes(resolutionPolicy)) {
        throw new Error('--resolve must be one of: never, after-suggest, after-accept');
      }
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const outcome = await client.addressReviewComment({
        projectId: proj.id,
        threadId,
        filePath: options.file,
        oldText: options.old,
        newText: options.new,
        occurrence: options.occurrence,
        position: options.position,
        line: options.line,
        column: options.column,
        precondition: {
          expectedVersion: options.expectedVersion,
          expectedTextSha256: options.expectedSha256,
        },
        reply: options.reply,
        resolutionPolicy: resolutionPolicy as 'never' | 'after-suggest' | 'after-accept',
        operationId: options.operationId,
        allowUnrelated: Boolean(options.allowUnrelated),
        ledgerPath: options.ledger,
        workingDirectory: process.cwd(),
        dryRun: Boolean(options.dryRun),
      });
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }
      if ('suggestion' in outcome && !('entry' in outcome)) {
        console.log(chalk.bold('Review workflow preview'));
        console.log(`  Operation: ${outcome.operationId}`);
        console.log(`  Thread: ${outcome.threadId}`);
        console.log(`  Document: ${outcome.path}`);
        console.log(`  Source version: ${outcome.suggestion.version}`);
        console.log(`  Related to comment: ${outcome.relatedToComment}`);
        console.log(`  Resolution policy: ${outcome.resolutionPolicy}`);
      } else {
        console.log(chalk.bold('Review comment addressed'));
        console.log(`  Operation: ${outcome.operationId}`);
        console.log(`  State: ${outcome.entry.state}`);
        console.log(`  Changes: ${outcome.entry.changeIds.join(', ')}`);
        console.log(`  Reply: ${outcome.entry.replyStatus}`);
        console.log(`  Comment resolved: ${Boolean(outcome.entry.commentResolvedAt)}`);
        console.log(`  Resumed: ${outcome.resumed}`);
      }
      setLastProject(proj.id);
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

reviewCmd
  .command('status [project]')
  .description('Show durable local review operations')
  .option('--ledger <path>', 'Review ledger path (default: .olcli-review.json)')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Reading review ledger...');
    if (!options.json) spinner.start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const ledger = await client.getReviewStatus({
        projectId: proj.id,
        ledgerPath: options.ledger,
        workingDirectory: process.cwd(),
      });
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(ledger, null, 2));
        return;
      }
      if (ledger.entries.length === 0) {
        console.log(chalk.yellow('No review operations recorded'));
        return;
      }
      for (const entry of ledger.entries) {
        console.log(`${chalk.cyan(entry.operationId)} ${entry.state}`);
        console.log(`  Thread: ${entry.threadId}`);
        console.log(`  Document: ${entry.path}`);
        console.log(`  Changes: ${entry.changeIds.length}`);
        console.log(`  Reply: ${entry.replyStatus}`);
        console.log(`  Policy: ${entry.resolutionPolicy}`);
      }
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

reviewCmd
  .command('reconcile [project]')
  .description('Reconcile ledger entries with current Overleaf review state')
  .option('--operation <uuid...>', 'Limit reconciliation to explicit operation IDs')
  .option('--ledger <path>', 'Review ledger path (default: .olcli-review.json)')
  .option('--dry-run', 'Preview classifications and comment resolutions')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora(options.dryRun ? 'Previewing reconciliation...' : 'Reconciling reviews...');
    if (!options.json) spinner.start();
    try {
      if (!options.dryRun) {
        requireExperimentalReview(
          Boolean(program.opts().experimentalReview) || isExperimentalReviewEnabled(),
          'review reconciliation writes'
        );
      }
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const result = await client.reconcileReview({
        projectId: proj.id,
        operationIds: options.operation,
        ledgerPath: options.ledger,
        workingDirectory: process.cwd(),
        dryRun: Boolean(options.dryRun),
      });
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.items.length === 0) {
        console.log(chalk.yellow('No review operations selected'));
        return;
      }
      for (const item of result.items) {
        console.log(`${chalk.cyan(item.operationId)} ${item.previousState} → ${item.state}`);
        console.log(`  Active changes: ${item.activeChangeIds.length}`);
        console.log(`  Comment resolved: ${item.commentResolved}`);
        if (item.commentResolutionPlanned) console.log('  Comment resolution: planned');
      }
      setLastProject(proj.id);
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

reviewCmd
  .command('annotate-commit <operationId> [project]')
  .description('Record a verified Git commit on a review ledger entry')
  .option('--commit <ref>', 'Git ref to record (default: HEAD)')
  .option('--ledger <path>', 'Review ledger path (default: .olcli-review.json)')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (operationId, project, options) => {
    const spinner = ora('Annotating review operation...');
    if (!options.json) spinner.start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const entry = await client.annotateReviewCommit({
        projectId: proj.id,
        operationId,
        commit: options.commit,
        ledgerPath: options.ledger,
        workingDirectory: process.cwd(),
      });
      spinner.stop();
      if (options.json) console.log(JSON.stringify(entry, null, 2));
      else console.log(`Recorded Git commit ${chalk.cyan(entry.gitCommit)} for ${entry.operationId}`);
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

reviewCmd
  .command('trailers <operationId> [project]')
  .description('Print Git commit trailers for a review operation')
  .option('--ledger <path>', 'Review ledger path (default: .olcli-review.json)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (operationId, project, options) => {
    const spinner = ora('Reading review metadata...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const trailers = await client.getReviewCommitTrailers({
        projectId: proj.id,
        operationId,
        ledgerPath: options.ledger,
        workingDirectory: process.cwd(),
      });
      spinner.stop();
      console.log(trailers.join('\n'));
    } catch (error: unknown) {
      failCommand(spinner, error, false);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY PROJECT HISTORY
// ─────────────────────────────────────────────────────────────────────────────

const historyCmd = program
  .command('history')
  .description('Inspect Overleaf project history without restoring or mutating it');

historyCmd
  .command('list [project]')
  .description('List normalized Overleaf project-history update groups')
  .option('-n, --limit <n>', 'Maximum entries to return (1-200)', value => parseInt(value, 10))
  .option('--before <version>', 'Return entries older than this project-history version', parseInt)
  .option('--min-count <n>', 'Minimum batch requested from Overleaf (1-100)', value => parseInt(value, 10))
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Fetching Overleaf project history...');
    if (!options.json) spinner.start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const result = await client.listHistory(proj.id, {
        limit: options.limit,
        before: options.before,
        minCount: options.minCount,
      });
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(chalk.dim('Versions below are Overleaf project-history versions, not Git commits or document OT versions.'));
      if (result.entries.length === 0) {
        console.log(chalk.yellow('No history entries found'));
        return;
      }
      for (const entry of result.entries) {
        const authors = entry.authors.map(author => author.name).join(', ') || 'Unknown';
        console.log(chalk.bold(`${entry.fromVersion} → ${entry.toVersion}`));
        console.log(`  ${entry.endedAt} · ${authors}`);
        if (entry.pathnames.length > 0) console.log(`  Edited: ${entry.pathnames.join(', ')}`);
        for (const operation of entry.projectOperations) {
          const destination = operation.newPath ? ` → ${operation.newPath}` : '';
          console.log(`  ${operation.kind}: ${operation.path}${destination}`);
        }
        for (const label of entry.labels) console.log(`  Label: ${label.comment}`);
        if (entry.origin) console.log(`  Origin: ${entry.origin.kind}`);
      }
      if (result.nextBefore !== undefined) {
        console.log(chalk.dim(`More history: rerun with --before ${result.nextBefore}`));
      }
      setLastProject(proj.id);
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

historyCmd
  .command('diff <file> [project]')
  .description('Diff one file between two Overleaf project-history versions')
  .requiredOption('--from <version>', 'Older project-history version', parseInt)
  .requiredOption('--to <version>', 'Newer project-history version', parseInt)
  .option('--no-content', 'Omit chunk text and return metadata/counts only')
  .option('--include-unchanged', 'Include unchanged chunks (may return most of the document)')
  .option('--json', 'Output as JSON')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (file, project, options) => {
    const spinner = ora('Fetching read-only history diff...');
    if (!options.json) spinner.start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      const result = await client.diffHistory(
        proj.id,
        file,
        options.from,
        options.to,
        {
          includeContent: options.content !== false,
          includeUnchanged: Boolean(options.includeUnchanged),
        }
      );
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(chalk.dim('Versions below are Overleaf project-history versions, not Git commits or document OT versions.'));
      console.log(chalk.bold(`${result.path}: ${result.fromVersion} → ${result.toVersion}`));
      console.log(`  File operation: ${result.file.operation}`);
      if (result.binary) {
        console.log(chalk.yellow('  Binary file: textual diff is unavailable.'));
        return;
      }
      console.log(`  +${result.stats.insertedCharacters} -${result.stats.deletedCharacters} unchanged=${result.stats.unchangedCharacters}`);
      for (const chunk of result.chunks) {
        const marker = chunk.kind === 'insert' ? '+' : chunk.kind === 'delete' ? '-' : ' ';
        const header = `${marker} ${chunk.kind} ${chunk.length} chars at diff offset ${chunk.offset}`;
        console.log(chunk.kind === 'insert' ? chalk.green(header) : chunk.kind === 'delete' ? chalk.red(header) : chalk.dim(header));
        if (chunk.text !== undefined) {
          for (const line of chunk.text.split('\n')) console.log(`${marker} ${line}`);
        }
      }
      if (result.chunks.length === 0) console.log(chalk.dim('  No changed text chunks.'));
      setLastProject(proj.id);
    } catch (error: unknown) {
      failCommand(spinner, error, Boolean(options.json));
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      const outputPath = options.output || `${proj.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.zip`;

      writeFileSync(outputPath, zip);
      spinner.succeed(`Downloaded: ${outputPath} (${(zip.length / 1024).toFixed(1)} KB)`);

      setLastProject(proj.id);
    } catch (error: any) {
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('pdf [project]')
  .description('Compile and download PDF')
  .option('-o, --output <path>', 'Output path (default: <project-name>.pdf)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Compiling project...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      spinner.text = 'Compiling...';
      const pdf = await client.downloadPdf(proj.id);
      const outputPath = options.output || `${proj.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.pdf`;

      writeFileSync(outputPath, pdf);
      spinner.succeed(`Downloaded PDF: ${outputPath} (${(pdf.length / 1024).toFixed(1)} KB)`);

      setLastProject(proj.id);
    } catch (error: any) {
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('output [type]')
  .description('Download compile output files (bbl, log, aux, etc.)')
  .option('-o, --output <path>', 'Output path')
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
      const result = await client.compileWithOutputs(proj.id);

      if (result.status !== 'success') {
        spinner.warn(`Compilation ${result.status}, but output files may still be available`);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('upload <file> [project]')
  .description('Upload a file to a project')
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
      // Preserve relative subfolders, but never recreate an absolute local
      // machine path inside the Overleaf project.
      const fileName = defaultUploadRemotePath(file);

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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('rename <oldname> <newname> [project]')
  .alias('mv')
  .description('Rename a file or folder in a project')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (oldname, newname, project, options) => {
    const spinner = ora('Renaming file...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);
      await client.renameByPath(proj.id, oldname, newname);
      spinner.succeed(`Renamed: ${oldname} → ${newname}`);
      setLastProject(proj.id);
    } catch (error: any) {
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// COMPILE COMMAND
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('compile [project]')
  .description('Compile a project (trigger PDF generation)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Compiling...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      const result = await client.compileProject(proj.id);
      spinner.succeed(`Compiled "${proj.name}"`);
      console.log(chalk.dim(`PDF URL: ${result.pdfUrl}`));

      setLastProject(proj.id);
    } catch (error: any) {
      spinner.fail(`Compilation failed: ${error.message}`);
      process.exit(1);
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
        let proj = await client.getProjectById(project!);
        if (!proj) {
          proj = await client.getProject(project!);
        }
        if (!proj) {
          spinner.fail(`Project not found: ${project}`);
          process.exit(1);
        }
        projectId = proj.id;
        projectName = proj.name;
        // Default directory is project name (sanitized) if not specified
        if (!dir) {
          targetDir = proj.name.replace(/[^a-zA-Z0-9-_]/g, '_');
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

      for (const entry of entries) {
        if (!entry.isDirectory) {
          const filePath = join(targetDir, entry.entryName);
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
            } catch (e) {
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

      // Save project metadata (with manifest of remote files for sync deletion tracking)
      const remoteManifest: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory) remoteManifest.push(e.entryName);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('push [dir]')
  .description('Upload local changes to Overleaf project')
  .option('--project <name>', 'Project name or ID (overrides .olcli.json)')
  .option('--all', 'Upload all files (not just changed)')
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

    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      projectId = meta.projectId;
      projectName = meta.projectName;
      lastPull = meta.lastPull ? new Date(meta.lastPull) : undefined;
      rootFolderId = meta.rootFolderId;
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
        let proj = await client.getProjectById(projectName!);
        if (!proj) {
          proj = await client.getProject(projectName!);
        }
        if (!proj) {
          spinner.fail(`Project not found: ${projectName}`);
          process.exit(1);
        }
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
      const { readdirSync, statSync } = await import('node:fs');

      const filesToUpload: { path: string; relativePath: string }[] = [];
      const filesIgnored: string[] = [];

      function scanDir(currentDir: string, relativeBase: string = '') {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        // Pre-compute sibling .tex set for the PDF special rule.
        const texSiblings = buildTexSiblingSet(
          entries.filter((e) => !e.isDirectory()).map((e) => e.name),
        );
        for (const entry of entries) {
          // Skip hidden files and .olcli.json (always — predates ignore subsystem)
          if (entry.name.startsWith('.')) continue;

          const fullPath = join(currentDir, entry.name);
          const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            // Test directory ignore (gitignore semantics: trailing slash matches dir)
            if (shouldIgnore(`${relativePath}/`, ignoreCtx)) {
              filesIgnored.push(`${relativePath}/`);
              continue;
            }
            scanDir(fullPath, relativePath);
          } else {
            if (shouldIgnore(relativePath, ignoreCtx, texSiblings)) {
              filesIgnored.push(relativePath);
              continue;
            }
            // Check if file is newer than last pull (unless --all)
            if (options.all || !lastPull) {
              filesToUpload.push({ path: fullPath, relativePath });
            } else {
              const stats = statSync(fullPath);
              if (stats.mtime > lastPull) {
                filesToUpload.push({ path: fullPath, relativePath });
              }
            }
          }
        }
      }

      scanDir(targetDir);

      if (options.showIgnored && filesIgnored.length > 0) {
        spinner.stop();
        console.log(chalk.bold(chalk.dim(`Ignored ${filesIgnored.length} file(s)/dir(s):`)));
        for (const p of filesIgnored) {
          console.log(chalk.dim(`  ${p}`));
        }
        spinner.start('Scanning files...');
      }

      if (filesToUpload.length === 0) {
        spinner.info('No files to upload');
        return;
      }

      if (options.dryRun) {
        spinner.stop();
        console.log(chalk.bold(`Would upload ${filesToUpload.length} file(s) to "${projectName}":`));
        for (const f of filesToUpload) {
          console.log(`  ${chalk.cyan(f.relativePath)}`);
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

      // Update last push time
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        meta.lastPush = new Date().toISOString();
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

      setLastProject(projectId!);
    } catch (error: any) {
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('sync [dir]')
  .description('Pull then push (bidirectional sync, propagates local deletions)')
  .option('--project <name>', 'Project name or ID')
  .option('--verbose', 'Show detailed file operations')
  .option('--no-delete', 'Do not propagate local deletions to the remote (safer)')
  .option('--dry-run', 'Show what would change without applying')
  .option('--no-default-ignore', 'Disable built-in LaTeX artifact ignore list (only .olignore applies)')
  .option('--no-ignore', 'Disable all ignore filtering (escape hatch — uploads everything)')
  .option('--show-ignored', 'Print files skipped by ignore rules')
  .option('--cookie <session>', 'Session cookie override')
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
        let proj = await client.getProjectById(projectName!);
        if (!proj) {
          proj = await client.getProject(projectName!);
        }
        if (!proj) {
          spinner.fail(`Project not found: ${projectName}`);
          process.exit(1);
        }
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
      const filesIgnored: string[] = [];
      const { readdirSync, statSync } = await import('node:fs');

      function scanLocalFiles(currentDir: string, relativeBase: string = '') {
        if (!existsSync(currentDir)) return;
        const entries = readdirSync(currentDir, { withFileTypes: true });
        const texSiblings = buildTexSiblingSet(
          entries.filter((e) => !e.isDirectory()).map((e) => e.name),
        );
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(currentDir, entry.name);
          const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (shouldIgnore(`${relativePath}/`, ignoreCtx)) {
              filesIgnored.push(`${relativePath}/`);
              continue;
            }
            scanLocalFiles(fullPath, relativePath);
          } else {
            if (shouldIgnore(relativePath, ignoreCtx, texSiblings)) {
              filesIgnored.push(relativePath);
              continue;
            }
            const stats = statSync(fullPath);
            localFiles.set(relativePath, {
              mtime: stats.mtime,
              content: readFileSync(fullPath)
            });
          }
        }
      }

      // Read local files before overwriting
      if (existsSync(metaPath)) {
        scanLocalFiles(targetDir);
      }

      if (options.showIgnored && filesIgnored.length > 0) {
        spinner.stop();
        console.log(chalk.bold(chalk.dim(`Ignored ${filesIgnored.length} local file(s)/dir(s):`)));
        for (const p of filesIgnored) {
          console.log(chalk.dim(`  ${p}`));
        }
        spinner.start();
      }

      // Extract remote files
      const remoteFiles = new Map<string, Buffer>();
      for (const entry of zip.getEntries()) {
        if (!entry.isDirectory) {
          remoteFiles.set(entry.entryName, entry.getData());
        }
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
        const filePath = join(targetDir, path);
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

      if (options.verbose) {
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

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

program
  .command('check')
  .description('Show credential sources and config path')
  .action(() => {
    console.log(chalk.bold('Configuration:'));
    console.log(`  Config file: ${getConfigPath()}`);
    console.log();

    console.log(chalk.bold('Credential sources (in order):'));
    console.log('  1. OVERLEAF_SESSION environment variable');
    console.log('  2. .olauth file in current directory');
    console.log('  3. Global config file');
    console.log();

    const cookie = getSessionCookie();
    if (cookie) {
      console.log(chalk.green('✓ Session cookie found'));
      console.log(chalk.dim('  Value is intentionally not displayed'));
    } else {
      console.log(chalk.yellow('✗ No session cookie found'));
    }
  });

program.parse(process.argv);
