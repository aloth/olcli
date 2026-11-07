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
 * Capabilities: import + export with refspec, option (for push --force).
 * State stored in .git/overleaf/ (manifest, marks, sha256 of every remote file).
 * A push is refused while Overleaf has changes the clone has not fetched.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OverleafClient } from './client.js';
import { formatErrorText } from './errors.js';
import {
  getSessionCookie,
  getBaseUrl,
  getSessionCookieName,
  getTimeout,
  getPasswordCredentials,
} from './config.js';
import { loadIgnore, shouldIgnore } from './ignore.js';
import { ByteReader, parseFastExport, type ParsedExport } from './fast-export.js';

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
  /**
   * sha256 of every file as it was on Overleaf after the last import or push.
   * `list` compares against it to tell git whether Overleaf changed, and a push
   * is refused while Overleaf holds changes the clone has not fetched. Clones
   * made by olcli 0.16.0 and earlier have no record.
   */
  remoteHashes?: Record<string, string>;
}

interface RemoteSnapshot {
  files: { path: string; data: Buffer }[];
  hashes: Record<string, string>;
}

/** Download the project and hash every file in it. */
async function remoteSnapshot(client: OverleafClient, projectId: string): Promise<RemoteSnapshot> {
  const zipBuffer = await client.downloadProject(projectId);
  const AdmZip = (await import('adm-zip')).default;
  const files: RemoteSnapshot['files'] = [];
  const hashes: Record<string, string> = {};
  for (const entry of new AdmZip(zipBuffer).getEntries()) {
    if (entry.isDirectory) continue;
    const data = entry.getData();
    files.push({ path: entry.entryName, data });
    hashes[entry.entryName] = createHash('sha256').update(data).digest('hex');
  }
  return { files, hashes };
}

/** Paths whose content differs between two snapshots, including added and removed files. */
function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((p) => before[p] !== after[p]).sort();
}

function localRemoteSha(): string | undefined {
  try {
    const sha = execSync(
      'git rev-parse --verify refs/overleaf/main 2>/dev/null',
      { encoding: 'utf-8', env: { ...process.env, GIT_DIR: getGitDir() } }
    ).trim();
    return /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
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
        fatal(`Authentication failed: ${formatErrorText(err, { verbose: true })}\nRun 'olcli auth' or set OVERLEAF_SESSION.`);
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

  fatal('No Overleaf credentials found. Run \'olcli auth\' or set OVERLEAF_SESSION.');
}

// ─── fast-export parsing (push) ───

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

/**
 * Why a push must not go ahead, or undefined when it may. Mirrors git's
 * non-fast-forward rejection: Overleaf has changes this clone has not fetched.
 */
function pushRefusal(recorded: Record<string, string> | undefined, current: Record<string, string>): string | undefined {
  if (!recorded) {
    return 'this clone has no record of the Overleaf state (made by olcli 0.16.0 or earlier); run git pull once, then push again';
  }
  const changed = changedPaths(recorded, current);
  if (changed.length === 0) return undefined;
  const shown = changed.slice(0, 3).join(', ') + (changed.length > 3 ? ` and ${changed.length - 3} more` : '');
  return `Overleaf has changes you do not have yet (${shown}); run git pull, then push again, or git push --force to overwrite them`;
}

/**
 * The commit being pushed must contain the last import, or the push would
 * replace what was fetched from Overleaf with an older version, for example
 * after a git pull whose merge conflict was never resolved.
 */
function notMergedRefusal(refs: string[]): string | undefined {
  const fetchedSha = localRemoteSha();
  if (!fetchedSha) return undefined;
  for (const ref of refs.length ? refs : ['HEAD']) {
    try {
      execSync(`git merge-base --is-ancestor ${fetchedSha} ${JSON.stringify(ref)}`, {
        stdio: 'ignore', env: { ...process.env, GIT_DIR: getGitDir() },
      });
    } catch {
      return 'your branch does not contain the last fetch from Overleaf; merge it first (git pull, resolve any conflict, commit), then push again, or git push --force to overwrite';
    }
  }
  return undefined;
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

  let clientPromise: Promise<OverleafClient> | undefined;
  const client = (): Promise<OverleafClient> => (clientPromise ??= getClient(baseUrl));
  // The snapshot `list` downloads is reused by the `import` that follows in the
  // same process, so a fetch downloads the project once.
  let fetched: RemoteSnapshot | undefined;
  let force = false;

  // Byte-exact reader: fast-export blobs are raw bytes, which a line reader
  // such as readline would decode as text and corrupt.
  const reader = new ByteReader(process.stdin);

  for (;;) {
    const line = await reader.readLine();
    if (line === null) break;
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
        // Lets git pass `option force true` for `git push --force`.
        'option',
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
      // Tell git which commit the remote is at. refs/overleaf/main is the
      // commit of the last import or push; it is only still true if Overleaf
      // has not changed since. Before a fetch, download the project and
      // compare: unchanged reports that commit (git has nothing to do),
      // changed reports '?' so git asks for an import. For a push the check
      // happens in export instead, against a fresh download.
      const remoteSha = localRemoteSha();
      let report = remoteSha ?? '?';
      if (trimmed === 'list' && remoteSha) {
        fetched = await remoteSnapshot(await client(), projectId);
        const changed = state.remoteHashes ? changedPaths(state.remoteHashes, fetched.hashes) : ['(no record)'];
        if (changed.length > 0) report = '?';
        debug(`Overleaf changed since last import: ${changed.length ? changed.join(', ') : 'nothing'}`);
      }
      process.stdout.write(`${report} refs/heads/main\n`);
      process.stdout.write('@refs/heads/main HEAD\n');
      process.stdout.write('\n'); // blank line terminates
      debug(`> list response sent (sha=${report})`);
      continue;
    }

    if (trimmed.startsWith('import ')) {
      // import refs/heads/main
      // May be followed by more "import" lines, terminated by blank line
      const refs: string[] = [trimmed.slice(7)];

      // Consume additional import lines until blank
      for (;;) {
        const nextLine = await reader.readLine();
        if (nextLine === null) break;
        const next = nextLine.trim();
        if (next === '') break;
        if (next.startsWith('import ')) {
          refs.push(next.slice(7));
        }
      }

      debug(`Import requested for: ${refs.join(', ')}`);

      debug('Generating fast-import stream...');
      const snapshot = fetched ?? await remoteSnapshot(await client(), projectId);
      fetched = undefined;

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

      // Nothing changed on Overleaf since the last import or push: write no
      // commit, so the history does not fill up with empty imports.
      const parentSha = localRemoteSha();
      if (parentSha && state.remoteHashes && changedPaths(state.remoteHashes, snapshot.hashes).length === 0) {
        process.stdout.write('done\n');
        debug('Import: Overleaf unchanged, no commit');
        continue;
      }

      // Write blobs
      for (const { path, data } of snapshot.files) {
        newManifest.push(path);
        mark++;

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

      // Parent: the last imported or pushed commit, if any
      if (parentSha) {
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
      state.remoteHashes = snapshot.hashes;
      saveState(state);

      debug(`Import complete: ${fileMarks.length} files, ${removedFiles.length} deletions`);
      continue;
    }

    if (trimmed.startsWith('export')) {
      // Push: git sends a fast-export stream on stdin
      debug('Export (push) starting — reading fast-export stream...');

      const parsed = await parseFastExport(reader);

      debug(`Parsed export: ${parsed.files.length} modifications, ${parsed.deletes.length} deletions`);

      if (parsed.files.length === 0 && parsed.deletes.length === 0) {
        debug('Nothing to push.');
        // Don't report ok — nothing was actually pushed.
        // This prevents git from advancing the remote tracking ref.
        process.stdout.write('\n');
      } else {
        const overleaf = await client();
        // Refuse to overwrite edits made on Overleaf since the last fetch, the
        // way git refuses a non-fast-forward push. --force skips the check.
        const before = await remoteSnapshot(overleaf, projectId);
        const refusal = force ? undefined : (pushRefusal(state.remoteHashes, before.hashes) ?? notMergedRefusal(parsed.refs));
        if (refusal) {
          process.stdout.write(`error refs/heads/main ${refusal}\n\n`);
          debug(`Push refused: ${refusal}`);
          continue;
        }

        await pushChanges(overleaf, projectId, parsed, state);

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
        // Record Overleaf as it is after the push, as Overleaf stores it, so
        // the next push does not mistake our own upload for a coauthor's edit.
        state.remoteHashes = (await remoteSnapshot(overleaf, projectId)).hashes;
        saveState(state);
      }

      debug('Export complete.');
      continue;
    }

    if (trimmed.startsWith('option ')) {
      if (trimmed === 'option force true' || trimmed === 'option force false') {
        force = trimmed.endsWith('true');
        process.stdout.write('ok\n');
      } else {
        process.stdout.write('unsupported\n');
      }
      continue;
    }

    // Unknown command
    debug(`Unknown command: ${trimmed}`);
    fatal(`Unsupported command: ${trimmed}`);
  }

}

// Gracefully handle EPIPE (git closed the pipe before we finished writing)
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main().catch((err) => {
  fatal(formatErrorText(err, { verbose: true }));
});
