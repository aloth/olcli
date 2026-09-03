#!/usr/bin/env node
/**
 * olcli MCP Server
 *
 * Exposes OverleafClient methods as MCP tools so AI assistants
 * (Claude Desktop, Cursor, Windsurf, …) can manage Overleaf projects.
 *
 * Transport: stdio (standard for Claude Desktop / Cursor / Windsurf)
 *
 * Auth: reads session cookie from OVERLEAF_SESSION env var or .olauth file in cwd.
 *
 * Start:
 *   npx @aloth/olcli-mcp
 *   node dist/mcp.js
 *   npm run mcp          # (from repo root)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AdmZip from 'adm-zip';

import { OverleafClient } from './client.js';
import { resolveRemotePath, resolveWithin, normalizeRemotePath } from './paths.js';
import { planProjectRenames } from './rename-plan.js';
import { scanLocalFiles } from './scan.js';
import { compareTrees, filterRemoteTree, renderFileDiff } from './diff.js';
import { loadIgnore } from './ignore.js';
import {
  getSessionCookie,
  getBaseUrl,
  getSessionCookieName,
  setSessionCookie,
  setSessionCookieName,
  getPasswordCredentials,
} from './config.js';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Resolve session cookie: env var → .olauth file in cwd → stored config.
 */
function resolveSessionCookie(): string {
  // 1. Explicit environment variable
  if (process.env.OVERLEAF_SESSION) {
    return process.env.OVERLEAF_SESSION.trim();
  }

  // 2. .olauth file in current working directory
  const olauth = join(process.cwd(), '.olauth');
  if (existsSync(olauth)) {
    try {
      const raw = readFileSync(olauth, 'utf-8').trim();
      if (raw) return raw;
    } catch {
      // fall through
    }
  }

  // 3. Stored via `olcli auth` (Conf-based config)
  const stored = getSessionCookie();
  if (stored) return stored;

  throw new Error(
    'No Overleaf session cookie found.\n' +
    'Set OVERLEAF_SESSION=<cookie>, run `olcli auth`, or save password login credentials with `olcli auth --email <email> --password <password>`.'
  );
}

// ---------------------------------------------------------------------------
// Lazy client factory — initialised once, reused across requests
// ---------------------------------------------------------------------------

let _client: OverleafClient | null = null;

async function getClient(): Promise<OverleafClient> {
  if (_client) return _client;
  const baseUrl = process.env.OVERLEAF_BASE_URL ?? getBaseUrl();
  const cookieName = getSessionCookieName();

  try {
    const cookie = resolveSessionCookie();
    _client = await OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
  } catch (error) {
    const credentials = getPasswordCredentials();
    if (!credentials) throw error;

    _client = await OverleafClient.fromPasswordLogin(credentials.email, credentials.password, baseUrl);
    const sessionCookie = _client.getSessionCookiePair(cookieName);
    if (sessionCookie) {
      setSessionCookieName(sessionCookie.name);
      setSessionCookie(sessionCookie.value);
    }
  }

  return _client;
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: 'olcli',
    version: '0.8.0',
  },
  {
    capabilities: { tools: {} },
  }
);

// ---------------------------------------------------------------------------
// Helper: wrap async tool handlers with consistent error formatting
// ---------------------------------------------------------------------------

function wrapTool<T>(fn: () => Promise<T>): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return fn().then(
    (result) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    }),
    (err: unknown) => ({
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    })
  );
}

// ---------------------------------------------------------------------------
// Tool: list_projects
// ---------------------------------------------------------------------------

server.tool(
  'list_projects',
  'List all Overleaf projects in the account. Returns project IDs, names, and metadata.',
  async () =>
    wrapTool(async () => {
      const client = await getClient();
      return client.listProjects();
    })
);

// ---------------------------------------------------------------------------
// Tool: get_project_info
// ---------------------------------------------------------------------------

server.tool(
  'get_project_info',
  'Get detailed information about an Overleaf project including its file tree (folders, docs, and files).',
  {
    project_id: z.string().describe('The Overleaf project ID (24-char hex string)'),
  },
  async ({ project_id }) =>
    wrapTool(async () => {
      const client = await getClient();
      return client.getProjectInfo(project_id);
    })
);

// ---------------------------------------------------------------------------
// Tool: pull_project
// ---------------------------------------------------------------------------

server.tool(
  'pull_project',
  'Download and extract an Overleaf project as a zip to a local directory. Creates the directory if it does not exist.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    output_dir: z.string().describe('Local directory path to extract files into'),
    overwrite: z
      .boolean()
      .optional()
      .default(false)
      .describe('Overwrite existing files (default: false)'),
  },
  async ({ project_id, output_dir, overwrite }) =>
    wrapTool(async () => {
      const client = await getClient();
      const zipBuf = await client.downloadProject(project_id);
      const outDir = resolve(output_dir);
      mkdirSync(outDir, { recursive: true });

      const zip = new AdmZip(zipBuf);
      const entries = zip.getEntries();
      const extracted: string[] = [];
      const skipped: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const destPath = join(outDir, entry.entryName);
        if (!overwrite && existsSync(destPath)) {
          skipped.push(entry.entryName);
          continue;
        }
        // Ensure parent dir exists
        mkdirSync(join(outDir, entry.entryName.split('/').slice(0, -1).join('/')), { recursive: true });
        writeFileSync(destPath, entry.getData());
        extracted.push(entry.entryName);
      }

      return {
        output_dir: outDir,
        extracted_count: extracted.length,
        skipped_count: skipped.length,
        extracted,
        skipped,
      };
    })
);

// ---------------------------------------------------------------------------
// Tool: push_file
// ---------------------------------------------------------------------------

server.tool(
  'push_file',
  'Upload a local file to an Overleaf project. The remote path is inferred from the file_path argument.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    local_path: z.string().describe('Absolute or relative path of the local file to upload'),
    remote_path: z
      .string()
      .optional()
      .describe(
        'Target path within the project. Defaults to the basename for absolute local paths, or the relative path as given (e.g. "figures/diagram.png")'
      ),
  },
  async ({ project_id, local_path, remote_path }) =>
    wrapTool(async () => {
      const client = await getClient();
      const absPath = resolve(local_path);
      const content = await readFile(absPath);
      const remoteName = resolveRemotePath(local_path, remote_path);
      return client.uploadFile(project_id, null, remoteName, content);
    })
);

// ---------------------------------------------------------------------------
// Tool: compile
// ---------------------------------------------------------------------------

server.tool(
  'compile',
  'Compile an Overleaf project using the remote LaTeX compiler. Returns the PDF URL and any log messages.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    resource_path: z
      .string()
      .optional()
      .describe('Path of a .tex file in the project to compile as the root document. E.g. "paper.tex", "folder/test.tex"'),
  },
  async ({ project_id, resource_path }) =>
    wrapTool(async () => {
      const client = await getClient();
      return client.compileProject(project_id, resource_path);
    })
);

// ---------------------------------------------------------------------------
// Tool: download_pdf
// ---------------------------------------------------------------------------

server.tool(
  'download_pdf',
  'Compile an Overleaf project and download the resulting PDF to a local file.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    output_path: z.string().describe('Local file path where the PDF should be saved (e.g. output.pdf)'),
    resource_path: z
      .string()
      .optional()
      .describe('Path of a .tex file in the project to compile as the root document. E.g. "paper.tex", "folder/test.tex"'),
  },
  async ({ project_id, output_path, resource_path }) =>
    wrapTool(async () => {
      const client = await getClient();
      const pdfBuf = await client.downloadPdf(project_id, undefined, resource_path);
      const absPath = resolve(output_path);
      writeFileSync(absPath, pdfBuf);
      return {
        path: absPath,
        bytes: pdfBuf.length,
      };
    })
);

// ---------------------------------------------------------------------------
// Tool: list_comments
// ---------------------------------------------------------------------------

server.tool(
  'list_comments',
  'List review comments on an Overleaf project. Supports filtering by status (all, open, resolved).',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    status: z
      .enum(['all', 'open', 'resolved'])
      .optional()
      .default('all')
      .describe('Filter by comment status'),
    include_context: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include surrounding text context for each comment'),
  },
  async ({ project_id, status, include_context }) =>
    wrapTool(async () => {
      const client = await getClient();
      return client.listComments(project_id, {
        status,
        contextLines: include_context ? 3 : 0,
      });
    })
);

// ---------------------------------------------------------------------------
// Tool: get_entities
// ---------------------------------------------------------------------------

server.tool(
  'get_entities',
  'Get a flat list of all files and documents in an Overleaf project with their paths and types.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
  },
  async ({ project_id }) =>
    wrapTool(async () => {
      const client = await getClient();
      return client.getEntities(project_id);
    })
);

// ---------------------------------------------------------------------------
// Tool: download_file
// ---------------------------------------------------------------------------

server.tool(
  'download_file',
  'Download a single file from an Overleaf project by its path within the project.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    remote_path: z.string().describe('Path of the file within the project (e.g. main.tex or figures/fig1.pdf)'),
    output_path: z
      .string()
      .optional()
      .describe('Local path to save the file (default: basename of remote_path in cwd)'),
  },
  async ({ project_id, remote_path, output_path }) =>
    wrapTool(async () => {
      const client = await getClient();
      const fileBuf = await client.downloadByPath(project_id, remote_path);
      const destPath = resolve(output_path ?? remote_path.split('/').pop() ?? remote_path);
      writeFileSync(destPath, fileBuf);
      return {
        path: destPath,
        bytes: fileBuf.length,
        remote_path,
      };
    })
);

// ---------------------------------------------------------------------------
// Tool: add_comment
// ---------------------------------------------------------------------------

server.tool(
  'add_comment',
  'Add a review comment to a specific location in an Overleaf project document.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    doc_path: z.string().describe('Path of the document within the project (e.g. main.tex)'),
    content: z.string().describe('The comment text'),
    position: z.number().int().nonnegative().optional().describe('Character offset in the document where the comment is anchored'),
    length: z.number().int().nonnegative().optional().describe('Length of the highlighted text span (0 for a point comment)'),
    selected_text: z.string().optional().describe('The text being commented on (optional, used for context)'),
    line: z.number().int().positive().optional().describe('Line number in the document (1-based, alternative to position)'),
    column: z.number().int().nonnegative().optional().describe('Column number in the document (0-based, alternative to position)'),
  },
  async ({ project_id, doc_path, content, position, length, selected_text, line, column }) =>
    wrapTool(async () => {
      const client = await getClient();
      return client.addComment(project_id, {
        filePath: doc_path,
        content,
        position,
        length,
        selectedText: selected_text,
        line,
        column,
      });
    })
);

// ---------------------------------------------------------------------------
// Tool: reply_to_comment
// ---------------------------------------------------------------------------

server.tool(
  'reply_to_comment',
  'Add a reply to an existing comment thread on an Overleaf project.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    thread_id: z.string().describe('The comment thread ID (from list_comments)'),
    content: z.string().describe('The reply message text'),
  },
  async ({ project_id, thread_id, content }) =>
    wrapTool(async () => {
      const client = await getClient();
      const message = await client.postCommentMessage(project_id, thread_id, content);
      return { replied: true, thread_id, message };
    })
);

// ---------------------------------------------------------------------------
// Tool: resolve_comment
// ---------------------------------------------------------------------------

server.tool(
  'resolve_comment',
  'Mark a review comment thread as resolved.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    thread_id: z.string().describe('The comment thread ID (from list_comments)'),
  },
  async ({ project_id, thread_id }) =>
    wrapTool(async () => {
      const client = await getClient();
      return client.resolveComment(project_id, thread_id);
    })
);

// ---------------------------------------------------------------------------
// Tool: delete_entity
// ---------------------------------------------------------------------------

server.tool(
  'delete_entity',
  'Delete a file or document from an Overleaf project by its remote path.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    remote_path: z.string().describe('Path of the file/document to delete within the project'),
  },
  async ({ project_id, remote_path }) =>
    wrapTool(async () => {
      const client = await getClient();
      await client.deleteByPath(project_id, remote_path);
      return { deleted: remote_path };
    })
);

// ---------------------------------------------------------------------------
// Tool: rename_entity
// ---------------------------------------------------------------------------

server.tool(
  'rename_entity',
  'Rename a file or document within an Overleaf project.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    remote_path: z.string().describe('Current path of the file/document within the project'),
    new_name: z.string().describe('New filename (basename only, not a full path)'),
  },
  async ({ project_id, remote_path, new_name }) =>
    wrapTool(async () => {
      const client = await getClient();
      await client.renameByPath(project_id, remote_path, new_name);
      return { old_path: remote_path, new_name };
    })
);

// ---------------------------------------------------------------------------
// Tool: compile_with_outputs
// ---------------------------------------------------------------------------

server.tool(
  'compile_with_outputs',
  'Compile an Overleaf project and return all output file metadata (PDF, BBL, logs, etc.). Useful for arXiv submission workflows.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    resource_path: z
      .string()
      .optional()
      .describe('Path of a .tex file in the project to compile as the root document. E.g. "paper.tex", "folder/test.tex"'),
  },
  async ({ project_id, resource_path }) =>
    wrapTool(async () => {
      const client = await getClient();
      return client.compileWithOutputs(project_id, resource_path);
    })
);

// ---------------------------------------------------------------------------
// Tool: rename_project
// ---------------------------------------------------------------------------

server.tool(
  'rename_project',
  'Rename an Overleaf project itself (not a file inside it). Use rename_entity for files and folders.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    new_name: z.string().describe('New project name'),
  },
  async ({ project_id, new_name }) =>
    wrapTool(async () => {
      const client = await getClient();
      await client.renameProject(project_id, new_name);
      return { project_id, new_name };
    })
);

// ---------------------------------------------------------------------------
// Tool: plan_project_renames
//
// Deliberately plan-only. There is no apply counterpart on the MCP surface:
// a bulk rename across an entire account is unrecoverable (Overleaf keeps no
// project-name history), and an agent that can trigger it on a
// misunderstood instruction is a risk with no matching benefit. The agent
// computes and explains the plan; a human runs
// `olcli project rename-bulk --apply`.
// ---------------------------------------------------------------------------

server.tool(
  'plan_project_renames',
  'Preview a bulk project rename across the account. Returns the planned renames, skipped projects and any name collisions. This tool NEVER renames anything - applying the plan requires the human to run `olcli project rename-bulk --apply` in a terminal.',
  {
    match: z
      .string()
      .optional()
      .describe('Regex; only projects whose name matches are considered'),
    search: z
      .string()
      .optional()
      .describe('Literal substring to replace (not a regex)'),
    replace: z
      .string()
      .optional()
      .describe('Replacement text; supports $1/$2 backrefs when used with match'),
    prefix: z.string().optional().describe('Text to prepend to the name'),
    suffix: z.string().optional().describe('Text to append to the name'),
  },
  async ({ match, search, replace, prefix, suffix }) =>
    wrapTool(async () => {
      const client = await getClient();
      const projects = await client.listProjects();
      const plan = planProjectRenames(projects, { match, search, replace, prefix, suffix });
      return {
        ...plan,
        applied: false,
        note:
          plan.collisions.length > 0
            ? 'Collisions present. Overleaf allows duplicate names, so applying this would succeed silently and leave indistinguishable projects. Fix the pattern before proceeding.'
            : 'Preview only. Run `olcli project rename-bulk --apply` to execute.',
      };
    })
);

// ---------------------------------------------------------------------------
// Tool: diff_project
// ---------------------------------------------------------------------------

server.tool(
  'diff_project',
  'Compare local files against the current remote state of an Overleaf project and return the content-level differences. Read-only: nothing is uploaded or written. This is the MCP counterpart of `olcli diff`.',
  {
    project_id: z.string().describe('The Overleaf project ID'),
    local_dir: z.string().describe('Local directory to compare against the remote project'),
    file: z
      .string()
      .optional()
      .describe('Restrict the comparison to a single path, as it appears in the project'),
    name_only: z
      .boolean()
      .optional()
      .default(false)
      .describe('Omit the patch text and return only paths and statuses (default: false)'),
    context: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(3)
      .describe('Lines of context around each hunk (default: 3)'),
    no_default_ignore: z
      .boolean()
      .optional()
      .default(false)
      .describe('Disable the built-in LaTeX artifact ignore list; only .olignore applies'),
    no_ignore: z
      .boolean()
      .optional()
      .default(false)
      .describe('Disable all ignore filtering on both sides'),
  },
  async ({ project_id, local_dir, file, name_only, context, no_default_ignore, no_ignore }) =>
    wrapTool(async () => {
      const targetDir = resolve(local_dir);
      if (!existsSync(targetDir)) {
        throw new Error(`Directory not found: ${targetDir}`);
      }

      const client = await getClient();

      // Fetched fresh on every call, exactly like `olcli diff`. The manifest
      // records remote paths, never remote contents, so there is no snapshot to
      // compare against - and a diff that does not describe what a subsequent
      // push would overwrite answers a different question than the one asked.
      // One request: downloadProject returns the whole project as one archive.
      const zipBuffer = await client.downloadProject(project_id);
      const fetchedAt = new Date().toISOString();
      const zip = new AdmZip(zipBuffer);

      const ignoreCtx = loadIgnore(targetDir, {
        noDefaults: no_default_ignore,
        disableAll: no_ignore,
      });

      // Both sides go through the same filters. Filtering only the local side
      // would report every build artifact sitting on Overleaf as a deletion.
      const remoteFiles = filterRemoteTree(
        zip
          .getEntries()
          .filter((e) => !e.isDirectory)
          .map((e) => ({ path: e.entryName, data: e.getData() })),
        ignoreCtx,
        (path) => resolveWithin(targetDir, path) !== null,
      );

      const scan = scanLocalFiles(targetDir, ignoreCtx);
      const localFiles = new Map<string, Buffer>();
      for (const localFile of scan.files) {
        localFiles.set(localFile.relativePath, readFileSync(localFile.path));
      }

      let entries = compareTrees(localFiles, remoteFiles).filter((e) => e.status !== 'unchanged');

      if (file) {
        const wanted = normalizeRemotePath(file);
        entries = entries.filter((e) => e.path === wanted);
      }

      const files = entries.map((entry) => ({
        path: entry.path,
        status: entry.status,
        binary: entry.binary,
        // Only a plain push uploads and overwrites; remote-only files survive it,
        // so calling them "deleted" without this flag would misdescribe the effect.
        removed_only_by_push_delete: entry.status === 'deleted',
        ...(name_only
          ? {}
          : {
              patch: renderFileDiff(
                entry,
                localFiles.get(entry.path),
                remoteFiles.get(entry.path),
                { context },
              ),
            }),
      }));

      return {
        project_id,
        local_dir: targetDir,
        // The remote was read at this instant. A collaborator editing between
        // this call and a later push can still change the outcome.
        remote_fetched_at: fetchedAt,
        changed_count: files.length,
        files,
        note:
          files.length === 0
            ? 'No differences.'
            : 'Patches are oriented a/ = remote, b/ = local: + is content a push would upload, - is content it would overwrite.',
      };
    })
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't pollute the MCP stdio channel
  process.stderr.write('olcli MCP server started (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
