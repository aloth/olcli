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
import { fileURLToPath } from 'node:url';
import { OverleafClient } from './client.js';
import { resolveRemotePath, resolveWithin, normalizeRemotePath } from './paths.js';
import { planProjectRenames } from './rename-plan.js';
import { scanLocalFiles } from './scan.js';
import { compareTrees, filterRemoteTree, renderFileDiff, statusLetter } from './diff.js';
import {
  loadIgnore,
  DEFAULT_IGNORE_PATTERNS,
  type IgnoreContext,
} from './ignore.js';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const VERSION = pkg.version;
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

program
  .name('olcli')
  .description('Overleaf CLI - interact with Overleaf projects from the command line')
  .version(VERSION)
  .option('--base-url <url>', 'Overleaf instance base URL (overrides OVERLEAF_BASE_URL and config)')
  .option('--cookie-name <name>', 'Session cookie name (default: overleaf_session2, use overleaf.sid for older instances)')
  .option('--timeout <ms>', 'HTTP request timeout in milliseconds', parseInt)
  .option('--verbose', 'Print every HTTP request, status, and error response body to stderr');

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
  .option('-r, --resource <path>', 'Compile this .tex file as root document (e.g. paper.tex, folder/test.tex)')
  .option('--cookie <session>', 'Session cookie override')
  .action(async (project, options) => {
    const spinner = ora('Compiling project...').start();
    try {
      const client = await getClient(options.cookie);
      const proj = await resolveProject(client, project);

      spinner.text = 'Compiling...';
      const pdf = await client.downloadPdf(proj.id, undefined, options.resource);
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
// PROJECT COMMANDS (rename the project itself, not files inside it)
// ─────────────────────────────────────────────────────────────────────────────

const projectCmd = program
  .command('project')
  .description('Operate on projects themselves (rename, bulk rename)');

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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
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

program
  .command('diff [project] [dir]')
  .description('Show content-level differences between local files and the remote project')
  .option('--name-only', 'List changed paths instead of printing patches')
  .option('--file <path>', 'Diff a single file')
  .option('-U, --unified <n>', 'Lines of context around each hunk (default: 3)', parseInt)
  .option('--no-default-ignore', 'Disable built-in LaTeX artifact ignore list (only .olignore applies)')
  .option('--no-ignore', 'Disable all ignore filtering')
  .option('--cookie <session>', 'Session cookie override')
  .addHelpText('after', `
The remote side is fetched fresh on every run, so the diff describes the
project as it is right now - which is what a subsequent push would overwrite.
It is not a comparison against the last pull. A collaborator editing between
diff and push can still change the outcome; the fetch time is printed for that
reason.`)
  .action(async (project, dir, options) => {
    const targetDir = dir || '.';

    if (!existsSync(targetDir)) {
      console.error(chalk.red(`Directory not found: ${targetDir}`));
      process.exit(1);
    }

    const spinner = ora('Connecting...').start();
    try {
      const client = await getClient(options.cookie);

      let resolved;
      try {
        resolved = await resolveProject(client, project, targetDir);
      } catch (error: any) {
        spinner.fail(error.message);
        console.error('Either run from a directory with .olcli.json or pass a project name/ID');
        process.exit(1);
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
    } catch (error: any) {
      spinner.fail(`Failed: ${error.message}`);
      process.exit(1);
    }
  });

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
      console.log(chalk.dim(`  Value: ${cookie.substring(0, 20)}...`));
    } else {
      console.log(chalk.yellow('✗ No session cookie found'));
    }
  });

program.parse(process.argv);
