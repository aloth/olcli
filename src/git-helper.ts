#!/usr/bin/env node
import * as readline from 'node:readline';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import AdmZip from 'adm-zip';
import { execSync } from 'node:child_process';
import { OverleafClient } from './client.js';

const remote = process.argv[2] || 'origin';
const url = process.argv[3];


class GitRemoteHelper {
  private remote: string;
  private projectId: string;
  private baseUrl: string;
  private prefix: string;
  private client?: OverleafClient;

  constructor(remote: string, url: string) {
    this.remote = remote;
    this.prefix = `refs/overleaf/${remote}`;
    const urlT = url.split('/');
    this.projectId = urlT[urlT.length -1];
    this.baseUrl = urlT[0] + "//" + urlT[2];
  }

  public async initClient(): Promise<OverleafClient> {
    if (!this.client) {
      this.client = await OverleafClient.fromUrl(this.baseUrl);
    }
    return this.client;
  }

  public runCapabilities() {
    console.log('import');
    console.log('push');
    console.log(`refspec refs/heads/*:${this.prefix}/*`);
    console.log('option');
    console.log('list');
    console.log('');
  }

  public runOption(argv: string[]) {//TODO: Implement the options
    console.log('ok');
  }

  public runList(argv: string[]) {
    const isPushing = argv.includes('for-push');
    if (isPushing) {
      const hash = this.getLocalCommitHash(`${this.prefix}/main`);
      if (hash) {
        console.log(`${hash} refs/heads/main`);
      } else {
        console.log(`? refs/heads/main`);
      }
    } else {
      console.log(`? refs/heads/main`);
    }
    console.log(`@refs/heads/main HEAD`);
    console.log('');
  }

  public async runImport(refsToImport: string[]) {
    let tempDir = '';
    try {
      const client = await this.initClient();

      await client.forceSave(this.projectId); //Force save state online
      let project = await client.getProjectById(this.projectId);
      if (!project) {
        console.error(`\n[olcli] Error: Could not find project '${this.projectId}'`);
        process.exit(1);
      }

      const requestedRef = refsToImport[0] || 'refs/heads/main';
      const privateRef = requestedRef.replace('refs/heads/', `${this.prefix}/`);

      const overleafTime = Math.floor(new Date(project.lastUpdated).getTime() / 1000);
      const lastSyncTime = this.getLastSyncTime();

      if (lastSyncTime > 0 && overleafTime === lastSyncTime) {
        const localHash = this.getLocalCommitHash(privateRef);
        process.stdout.write(`feature done\n`);
        process.stdout.write(`reset ${privateRef}\n`);
        process.stdout.write(`from ${localHash}\n`);
        process.stdout.write(`done\n`, () => console.log(''));
        return;
      }

      //TODO: Add with logs (options)
      //console.error(`[olcli] Fetching project '${project.name}'...`);
      const zipBuffer = await client.downloadProject(this.projectId);

      tempDir = mkdtempSync(join(tmpdir(), 'overleaf-sync-'));
      const zipPath = join(tempDir, 'project.zip');
      const extractDir = join(tempDir, 'extracted');

      writeFileSync(zipPath, zipBuffer);
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractDir, true);

      const files = this.getFilesRecursively(extractDir);
      const commitMsg = "Sync from Overleaf\n";

      let streamData = '';
      streamData += `feature done\n`;
      streamData += `commit ${privateRef}\n`;
      streamData += `mark :1\n`;
      if(!project.lastUpdatedBy){
        streamData += `author Overleaf Sync <sync@overleaf.com> ${overleafTime} +0000\n`;
        streamData += `committer Overleaf Sync <sync@overleaf.com> ${overleafTime} +0000\n`;
      }else{
        streamData += `author ${project.lastUpdatedBy.firstName} ${project.lastUpdatedBy.lastName} <${project.lastUpdatedBy.email}> ${overleafTime} +0000\n`;
        streamData += `committer ${project.lastUpdatedBy.firstName} ${project.lastUpdatedBy.lastName} <${project.lastUpdatedBy.email}> ${overleafTime} +0000\n`;
      }
      streamData += `data ${Buffer.byteLength(commitMsg, 'utf8')}\n`;
      streamData += commitMsg;

      const parentHash = this.getLocalCommitHash(privateRef);
      if (parentHash) {
        streamData += `from ${parentHash}\n`;
      }

      process.stdout.write(streamData);

      for (const filePath of files) {
        let repoPath = relative(extractDir, filePath).replace(/\\/g, '/');
        repoPath = repoPath.replace(/^\/+/, '').replace(/^\.\//, '');
          const formattedPath = repoPath.includes(' ') ? `"${repoPath}"` : repoPath;
        const content = readFileSync(filePath);

        process.stdout.write(`M 100644 inline ${formattedPath}\n`);
        process.stdout.write(`data ${content.length}\n`);
        process.stdout.write(content);
        process.stdout.write(`\n`);
      }

      process.stdout.write(`done\n`, () => {console.log('');
                           this.setLastSyncTime(overleafTime)});

    } catch (error: any) {
      console.error(`\n[olcli] Error importing from Overleaf: ${error.message}`);
      process.exit(1);
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  public async runPush(refsToPush: string[]) {
    const [localRef, remoteRef] = refsToPush[0].split(':');
    const privateRef = remoteRef.replace('refs/heads/', `${this.prefix}/`);

    try {
      const client = await this.initClient();
      await client.forceSave(this.projectId);
      let project = await client.getProjectById(this.projectId);
      if (!project) {
        console.error(`error ${remoteRef} Project not found`);
        return;
      }

      const overleafTime = Math.floor(new Date(project.lastUpdated).getTime() / 1000);
      const lastSyncTime = this.getLastSyncTime();

      if (lastSyncTime > 0 && overleafTime > lastSyncTime) {
        console.log(`error ${remoteRef} fetch first`);
        console.log('');
        return;
      }

      let commitsStr = '';
      try {
        commitsStr = execSync(`git rev-list --reverse ${privateRef}..${localRef}`, { stdio:['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
      } catch {
        commitsStr = execSync(`git rev-list --reverse ${localRef}`, { encoding: 'utf8' }).trim();
      }

      if (!commitsStr) {
        console.log(`ok ${remoteRef}`);
        console.log('');
        return;
      }

      const commits = commitsStr.split('\n');

      const remoteFiles = new Map<string, { id: string, type: 'doc'|'file'|'folder' }>();
      const projectInfo = await client.getProjectInfo(this.projectId);
      if (projectInfo?.rootFolder?.[0]) {
        const buildFileMap = (folder: any, currentPath: string = '') => {
          for (const doc of folder.docs ||[]) remoteFiles.set(currentPath ? `${currentPath}/${doc.name}` : doc.name, { id: doc._id, type: 'doc' });
          for (const file of folder.fileRefs ||[]) remoteFiles.set(currentPath ? `${currentPath}/${file.name}` : file.name, { id: file._id, type: 'file' });
          for (const sub of folder.folders ||[]) {
            const subPath = currentPath ? `${currentPath}/${sub.name}` : sub.name;
            remoteFiles.set(subPath, { id: sub._id, type: 'folder' });
            buildFileMap(sub, subPath);
          }
        };
        buildFileMap(projectInfo.rootFolder[0]);
      }

      let folderTree = await client.getFolderTreeFromSocket(this.projectId) || {};

      for (const hash of commits) {
        const commitMsg = execSync(`git show -s --format=%s ${hash}`, { encoding: 'utf8' }).trim();
        const uploadStr = execSync(`git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r ${hash}`, { encoding: 'utf8' }).trim();
        const filesToUpload = uploadStr ? uploadStr.split('\n') :[];
        const deleteStr = execSync(`git diff-tree --no-commit-id --name-only --diff-filter=D -r ${hash}`, { encoding: 'utf8' }).trim();
        const filesToDelete = deleteStr ? deleteStr.split('\n') :[];

        for (const file of filesToUpload) {
          if (file === ".gitignore") continue;
          const content = execSync(`git show ${hash}:"${file}"`, { encoding: 'buffer' });
          await client.uploadFile(this.projectId, null, file, content, folderTree);
        }

        for (const file of filesToDelete) {
          const entity = remoteFiles.get(file);
          if (entity) {
            await client.deleteEntity(this.projectId, entity.id, entity.type);
            remoteFiles.delete(file);
          }
        }
      }

      const folderEntries = Array.from(remoteFiles.entries()).filter(([_, e]) => e.type === 'folder');
      folderEntries.sort(([pathA], [pathB]) => pathB.length - pathA.length);
      for (const[folderPath, entity] of folderEntries) {
        const hasChildren = Array.from(remoteFiles.keys()).some(k => k.startsWith(folderPath + '/'));
        if (!hasChildren) {
          try {
            await client.deleteEntity(this.projectId, entity.id, 'folder');
            remoteFiles.delete(folderPath);
          } catch {}
        }
      }

      const updatedProject = await client.getProjectById(this.projectId);
      if (updatedProject) {
        const newOverleafTime = Math.floor(new Date(updatedProject.lastUpdated).getTime() / 1000);
        this.setLastSyncTime(newOverleafTime);
      }

      execSync(`git update-ref ${privateRef} ${localRef}`);

      console.log(`ok ${remoteRef}`);
      console.log('');

    } catch (error: any) {
      console.log(`error ${remoteRef} Push failed: ${error.message}`);
      console.log('');
    }
  }

  private getFilesRecursively(dir: string, fileList: string[] =[]) {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        this.getFilesRecursively(fullPath, fileList);
      } else {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }

  private getLocalCommitHash(ref: string): string {
    try {
      return execSync(`git rev-parse ${ref}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }

  private getLastSyncTime(): number {
    try {
      return parseInt(execSync(`git config overleaf.${this.projectId}.lastsync`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim(), 10);
    } catch {
      return 0;
    }
  }

  private setLastSyncTime(time: number): void {
    execSync(`git config overleaf.${this.projectId}.lastsync ${time}`);
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const helper = new GitRemoteHelper(remote, url);

  let pendingImports: string[] = [];
  let pendingPushes: string[] =[];

  for await (const line of rl) {
    if (line === '') {
      if (pendingImports.length > 0) {
        await helper.runImport(pendingImports);
        pendingImports =[];
      } else if (pendingPushes.length > 0) {
        await helper.runPush(pendingPushes);
        pendingPushes =[];
      } else {
        process.exit(0);
      }
      continue;
    }

    const [cmd, ...args] = line.split(' ');

    switch (cmd) {
      case 'capabilities':
        helper.runCapabilities();
      break;
      case 'option':
        helper.runOption(args);
      break;
      case 'list':
        helper.runList(args);
      break;
      case 'import':
        pendingImports.push(args[0]);
      break;
      case 'push':
        pendingPushes.push(args[0]);
      break;
      case 'fetch':
        console.error('Fetch not supported. Use import.');
      process.exit(1);
      break;
      default:
        console.error(`[olcli] Unknown command: ${line}`);
    }
  }
}

main();
