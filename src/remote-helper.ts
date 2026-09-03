#!/usr/bin/env node
/**
 * git-remote-overleaf — Git remote helper for Overleaf projects.
 *
 * Allows native git commands against Overleaf:
 *   git clone overleaf::https://www.overleaf.com/project/<id>
 *   git pull
 *   git push
 *
 * Protocol reference: gitremote-helpers(7)
 *
 * Capabilities: import + export with refspec.
 * State stored in .git/overleaf/ (manifest).
 */

import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OverleafClient } from './client.js';
import {
  getSessionCookie,
  getBaseUrl,
  getSessionCookieName,
  getTimeout,
  getPasswordCredentials,
} from './config.js';
import { loadIgnore, shouldIgnore } from './ignore.js';

// ─── Logging (stderr only — stdout is the git protocol channel) ───

function debug(msg: string): void {
  if (process.env.GIT_REMOTE_OVERLEAF_DEBUG) {
    process.stderr.write(`[git-remote-overleaf] ${msg}\n`);
  }
}

function fatal(msg: string): never {
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
}

// ─── URL parsing ───

interface ParsedRemote {
  projectId: string;
  baseUrl: string;
}

/**
 * Parse an Overleaf project URL into base URL and project ID.
 *
 * Supported formats:
 *   https://www.overleaf.com/project/abc123
 *   overleaf::https://www.overleaf.com/project/abc123
 *   https://custom.overleaf.example.com/project/abc123
 *   abc123  (bare project ID, uses configured base URL)
 */
function parseRemoteUrl(url: string): ParsedRemote {
  // Strip the overleaf:: prefix if present (git passes the raw URL part)
  const cleaned = url.replace(/^overleaf::/, '');

  // Try parsing as URL with /project/<id> path
  const projectPathMatch = cleaned.match(/^(https?:\/\/[^/]+)\/project\/([a-f0-9]{24})$/i);
  if (projectPathMatch) {
    return { baseUrl: projectPathMatch[1], projectId: projectPathMatch[2] };
  }

  // Bare 24-char hex ID
  if (/^[a-f0-9]{24}$/i.test(cleaned)) {
    return { baseUrl: getBaseUrl(), projectId: cleaned };
  }

  fatal(`Cannot parse Overleaf URL: ${url}\n  Expected: https://<host>/project/<24-char-id>`);
}

// ─── State management (.git/overleaf/) ───

interface HelperState {
  /** Manifest of remote paths from last successful import */
  manifest: string[];
  /** fast-import mark counter */
  lastMark: number;
}

function getGitDir(): string {
  const gitDir = process.env.GIT_DIR;
  if (!gitDir) fatal('GIT_DIR not set — are you running inside git?');
  return resolve(gitDir); // Always return absolute path
}

function stateDir(): string {
  return join(getGitDir(), 'overleaf');
}

function ensureStateDir(): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadState(): HelperState {
  const path = join(stateDir(), 'state.json');
  if (!existsSync(path)) return { manifest: [], lastMark: 0 };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { manifest: [], lastMark: 0 };
  }
}

function saveState(state: HelperState): void {
  ensureStateDir();
  writeFileSync(join(stateDir(), 'state.json'), JSON.stringify(state, null, 2));
}


// ─── Authentication (reuses olcli's config chain) ───

async function getClient(baseUrl: string): Promise<OverleafClient> {
  const cookieName = getSessionCookieName();
  const cookie = getSessionCookie();
  const passwordCredentials = getPasswordCredentials();

  if (cookie) {
    try {
      const client = await OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
      client.setGlobalTimeout(getTimeout());
      return client;
    } catch (err) {
      if (!passwordCredentials) {
        fatal(`Authentication failed: ${(err as Error).message}\nRun 'olcli login' first.`);
      }
    }
  }

  if (passwordCredentials) {
    const client = await OverleafClient.fromPasswordLogin(
      passwordCredentials.email,
      passwordCredentials.password,
      baseUrl,
    );
    client.setGlobalTimeout(getTimeout());
    return client;
  }

  fatal('No Overleaf credentials found. Run \'olcli login\' or set OVERLEAF_SESSION.');
}

// ─── fast-export parsing (push) ───

interface ExportedFile {
  path: string;
  content: Buffer;
}

interface ExportedDelete {
  path: string;
}

interface ParsedExport {
  files: ExportedFile[];
  deletes: ExportedDelete[];
}

/**
 * Read fast-export stream from stdin and extract file modifications/deletions.
 *
 * The stream comes after we respond to the "export" command. Git sends
 * fast-export data terminated by "done\n".
 */
async function parseFastExport(rl: AsyncIterableIterator<string>): Promise<ParsedExport> {
  const files: ExportedFile[] = [];
  const deletes: ExportedDelete[] = [];
  const blobData = new Map<string, Buffer>(); // mark → data

  let currentMark = '';
  let dataBuffer = Buffer.alloc(0);

  // State machine for parsing the fast-export stream.
  // readline gives us lines; for binary `data <N>` sections we accumulate bytes.

  let state: 'command' | 'data' = 'command';
  let pendingDataBytes = 0;
  let pendingMark = '';
  let commitSection = false;
  for await (const line of rl) {
    if (state === 'data') {
      // Accumulate data — readline splits on \n so we rejoin
      const lineBytes = Buffer.from(line + '\n', 'binary');
      dataBuffer = Buffer.concat([dataBuffer, lineBytes]);
      if (dataBuffer.length >= pendingDataBytes) {
        // Trim to exact length
        const finalData = dataBuffer.subarray(0, pendingDataBytes);
        if (pendingMark) {
          blobData.set(pendingMark, finalData);
        }
        state = 'command';
        dataBuffer = Buffer.alloc(0);
        pendingMark = '';
      }
      continue;
    }

    // Command mode
    if (line === 'done' || line === '') {
      if (line === 'done') break;
      continue;
    }

    if (line.startsWith('blob')) {
      commitSection = false;
      continue;
    }

    if (line.startsWith('mark :')) {
      currentMark = line.slice(6);
      continue;
    }

    if (line.startsWith('data ')) {
      pendingDataBytes = parseInt(line.slice(5), 10);
      pendingMark = commitSection ? '' : currentMark;
      state = 'data';
      dataBuffer = Buffer.alloc(0);
      continue;
    }

    if (line.startsWith('commit ')) {
      commitSection = true;
      continue;
    }

    if (line.startsWith('committer ') || line.startsWith('author ')) {
      continue;
    }

    if (line.startsWith('from ') || line.startsWith('merge ')) {
      continue;
    }

    // File modification: M <mode> <dataref> <path>
    const mMatch = line.match(/^M \d+ :(\S+) (.+)$/);
    if (mMatch) {
      const [, markRef, path] = mMatch;
      const content = blobData.get(markRef);
      if (content) {
        files.push({ path, content });
      }
      continue;
    }

    // Inline modification: M <mode> inline <path>
    const mInline = line.match(/^M \d+ inline (.+)$/);
    if (mInline) {
      // Next will be a data line
      currentMark = `__inline_${mInline[1]}`;
      continue;
    }

    // Deletion: D <path>
    const dMatch = line.match(/^D (.+)$/);
    if (dMatch) {
      deletes.push({ path: dMatch[1] });
      continue;
    }
  }

  // Resolve any inline blobs
  for (const [mark, data] of blobData) {
    if (mark.startsWith('__inline_')) {
      const path = mark.slice(9);
      files.push({ path, content: data });
    }
  }

  return { files, deletes };
}

// ─── Push logic ───

async function pushChanges(
  client: OverleafClient,
  projectId: string,
  parsed: ParsedExport,
  _state: HelperState,
): Promise<void> {
  const ignoreCtx = loadIgnore(process.cwd(), {});

  // Upload modified/new files
  for (const file of parsed.files) {
    if (shouldIgnore(file.path, ignoreCtx)) {
      debug(`Skipping ignored file: ${file.path}`);
      continue;
    }
    debug(`Uploading: ${file.path}`);
    await client.uploadFile(projectId, null, file.path, file.content);
  }

  // Delete removed files
  for (const del of parsed.deletes) {
    debug(`Deleting: ${del.path}`);
    try {
      await client.deleteByPath(projectId, del.path);
    } catch (err) {
      // File might already be gone on remote
      debug(`Warning: Could not delete ${del.path}: ${(err as Error).message}`);
    }
  }
}

// ─── Protocol handler ───

async function main(): Promise<void> {
  // Args: git-remote-overleaf <remote-name> <url>
  const args = process.argv.slice(2);
  if (args.length < 1) {
    fatal('Usage: git-remote-overleaf <remote> [<url>]');
  }

  // The URL is usually the second arg; if only one arg, it IS the URL
  const rawUrl = args[1] || args[0];
  const { projectId, baseUrl } = parseRemoteUrl(rawUrl);

  debug(`Project ID: ${projectId}, Base URL: ${baseUrl}`);

  ensureStateDir();
  const state = loadState();

  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  const iterator = rl[Symbol.asyncIterator]();

  for await (const line of rl) {
    const trimmed = line.trim();
    debug(`< ${trimmed}`);

    if (trimmed === '') {
      // Empty line = end of command batch (for list/import/export batches)
      continue;
    }

    if (trimmed === 'capabilities') {
      // Declare what we support.
      ensureStateDir();
      // Create empty marks file if it doesn't exist (fast-export --import-marks
      // fails if file is missing; empty file = nothing previously exported).
      const marks = join(stateDir(), 'marks');
      if (!existsSync(marks)) {
        writeFileSync(marks, '');
      }

      const caps = [
        'import',
        'export',
        // Map remote refs/heads/* to a private namespace refs/overleaf/<remote>/*
        // This is critical: git uses the private namespace to track what the remote has.
        // Without a separate namespace, git can't compute the push delta.
        'refspec refs/heads/*:refs/overleaf/*',
        // import-marks/export-marks = passed to fast-export on push.
        `import-marks ${marks}`,
        `export-marks ${marks}`,
        '',  // blank line terminates capabilities
      ].join('\n');
      process.stdout.write(caps + '\n');
      debug(`> capabilities response sent (marks=${marks})`);
      continue;
    }

    if (trimmed === 'list' || trimmed === 'list for-push') {
      // Report what SHA the remote currently has.
      // Read from refs/overleaf/main (our private namespace ref updated by
      // git after import/export via the refspec mapping).
      let remoteSha: string | undefined;
      try {
        const sha = execSync(
          'git rev-parse --verify refs/overleaf/main 2>/dev/null',
          { encoding: 'utf-8', env: { ...process.env, GIT_DIR: getGitDir() } }
        ).trim();
        if (/^[a-f0-9]{40}$/.test(sha)) remoteSha = sha;
      } catch { /* not yet created */ }

      if (remoteSha) {
        process.stdout.write(`${remoteSha} refs/heads/main\n`);
      } else {
        process.stdout.write('? refs/heads/main\n');
      }
      process.stdout.write('@refs/heads/main HEAD\n');
      process.stdout.write('\n'); // blank line terminates
      debug(`> list response sent (sha=${remoteSha || '?'})`);
      continue;
    }

    if (trimmed.startsWith('import ')) {
      // import refs/heads/main
      // May be followed by more "import" lines, terminated by blank line
      const refs: string[] = [trimmed.slice(7)];

      // Consume additional import lines until blank
      for await (const nextLine of rl) {
        const next = nextLine.trim();
        if (next === '') break;
        if (next.startsWith('import ')) {
          refs.push(next.slice(7));
        }
      }

      debug(`Import requested for: ${refs.join(', ')}`);

      // Authenticate and fetch
      const client = await getClient(baseUrl);

      debug('Generating fast-import stream...');
      const zipBuffer = await client.downloadProject(projectId);
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();

      let mark = state.lastMark;
      const newManifest: string[] = [];
      const fileMarks: { path: string; mark: number }[] = [];

      // Emit feature lines so fast-import writes/reads marks.
      // This enables incremental import and allows fast-export to know
      // which objects were already imported.
      const marks = join(stateDir(), 'marks');
      process.stdout.write(`feature import-marks-if-exists=${marks}\n`);
      process.stdout.write(`feature export-marks=${marks}\n`);
      // feature done tells fast-import to expect "done" as terminator
      process.stdout.write('feature done\n');

      // Write blobs
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const path = entry.entryName;
        newManifest.push(path);
        mark++;

        const data = entry.getData();
        process.stdout.write(`blob\nmark :${mark}\ndata ${data.length}\n`);
        process.stdout.write(data);
        process.stdout.write('\n');
        fileMarks.push({ path, mark });
      }

      // Write commit
      mark++;
      const now = Math.floor(Date.now() / 1000);
      // Write to private namespace per refspec: refs/heads/* → refs/overleaf/*
      process.stdout.write(`commit refs/overleaf/main\n`);
      process.stdout.write(`mark :${mark}\n`);
      process.stdout.write(`committer Overleaf <overleaf@localhost> ${now} +0000\n`);
      const msg = 'Import from Overleaf';
      process.stdout.write(`data ${Buffer.byteLength(msg)}\n`);
      process.stdout.write(`${msg}\n`);

      // Parent: reference previous state if any
      if (state.manifest.length > 0) {
        process.stdout.write(`from refs/overleaf/main^0\n`);
      }

      // Deletions (files removed on Overleaf since last import)
      const removedFiles = state.manifest.filter(f => !newManifest.includes(f));
      for (const f of removedFiles) {
        process.stdout.write(`D ${f}\n`);
      }

      // Modifications (all current files)
      for (const fm of fileMarks) {
        process.stdout.write(`M 100644 :${fm.mark} ${fm.path}\n`);
      }

      process.stdout.write('\n'); // end of commit
      process.stdout.write('done\n');

      // Update state
      state.manifest = newManifest;
      state.lastMark = mark;
      saveState(state);

      debug(`Import complete: ${fileMarks.length} files, ${removedFiles.length} deletions`);
      continue;
    }

    if (trimmed.startsWith('export')) {
      // Push: git sends a fast-export stream on stdin
      debug('Export (push) starting — reading fast-export stream...');

      const client = await getClient(baseUrl);
      const parsed = await parseFastExport(iterator);

      debug(`Parsed export: ${parsed.files.length} modifications, ${parsed.deletes.length} deletions`);

      if (parsed.files.length === 0 && parsed.deletes.length === 0) {
        debug('Nothing to push.');
        // Don't report ok — nothing was actually pushed.
        // This prevents git from advancing the remote tracking ref.
        process.stdout.write('\n');
      } else {
        await pushChanges(client, projectId, parsed, state);

        // Report success for each ref that was pushed
        process.stdout.write('ok refs/heads/main\n');
        process.stdout.write('\n');

        // Update state with new manifest
        const currentManifest = new Set(state.manifest);
        for (const del of parsed.deletes) {
          currentManifest.delete(del.path);
        }
        for (const file of parsed.files) {
          currentManifest.add(file.path);
        }
        state.manifest = [...currentManifest];
        saveState(state);
      }

      debug('Export complete.');
      continue;
    }

    if (trimmed.startsWith('option ')) {
      // We don't support any options currently
      process.stdout.write('unsupported\n');
      continue;
    }

    // Unknown command
    debug(`Unknown command: ${trimmed}`);
    fatal(`Unsupported command: ${trimmed}`);
  }

  rl.close();
}

// Gracefully handle EPIPE (git closed the pipe before we finished writing)
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main().catch((err) => {
  fatal(err.message || String(err));
});
