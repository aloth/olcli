#!/usr/bin/env node
import * as readline from 'node:readline';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import AdmZip from 'adm-zip';
import { execSync } from 'node:child_process';

const url = process.argv[3].split('/');

const projectId = url[url.length -1];
const baseUrl = url[0]+"//"+url[2];

const { getClient } = await import('./client.js');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let pendingImportRef = '';
let pendingPushRef = '';

for await (const line of rl) {
  //console.error(`[DEBUG] Git asked: ${line}`);
  let argv = line.split(' ');

  switch (argv[0]){
    case "capabilities" :
      console.log('import');
    console.log('refspec refs/heads/*:refs/heads/*');
    console.log('option');
    console.log('list');
    console.log('push');
    console.log('');
    break;
    case "option":
      runOption(argv);
    break;
    case "list":
      runList(argv);
    break;
    case "push":
      pendingPushRef = argv[1].split(':')[1];
    break;
    case "import":
      pendingImportRef = argv[1];
    break;

    case "":
      if (pendingImportRef !== '') {
      await runImport(pendingImportRef);
      pendingImportRef = '';
    } else if (pendingPushRef !== '') {
      await runPush(pendingPushRef);
      pendingPushRef = '';
    } else {
      process.exit(0);
    }
    break;
  }
}

    /*
     * Function handling the option request from git-remote-helper
     */
function runOption(argv:  string[]): void {//TODO: Actually handle options
  console.log("unsupported")
}
/*
 * Function handling the list request from git-remote-helper
 */
function runList(argv:  string[]): void {
  const isPushing = argv.includes('for-push');

  if (isPushing) {
    try {
      const remoteName = process.argv[2];
      const hash = execSync(`git rev-parse refs/remotes/${remoteName}/main`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8'
      }).trim();
      console.log(`${hash} refs/heads/main`);
    } catch {
      console.log(`? refs/heads/main`);
    }
  } else {
    console.log(`? refs/heads/main`);
  }

  console.log(`@refs/heads/main HEAD`);
  console.log('');
}

/*
 * Function handling the push request from git-remote-helper
 */
async function runPush(refToUpdate:  string){

  const remoteName = process.argv[2];
  const branchName = refToUpdate.split('/').pop();
  const trackingRef = `refs/remotes/${remoteName}/${branchName}`;

  let commitsStr = '';
  try {
    commitsStr = execSync(`git rev-list --reverse ${trackingRef}..${refToUpdate}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch (e) {
    commitsStr = execSync(`git rev-list --reverse ${refToUpdate}`, { encoding: 'utf8' }).trim();
  }

  if (!commitsStr) {
    console.log(`ok ${refToUpdate}`);
    console.log('');
    return;
  }
  const commits = commitsStr.split('\n');

  let tempDir = '';
  try {
    const client = await getClient();

    let project = await client.getProjectById(projectId);
    if (!project) project = await client.getProject(projectId);
    if (!project) {
      console.log(`error ${refToUpdate} Could not find project : ${projectId}`);
      return;
    }
    const overleafTime = Math.floor(new Date(project.lastUpdated).getTime() / 1000);
    const localTime = getLastSyncTime();

    if (overleafTime > localTime ){
      console.log(`error ${refToUpdate} Remote has newer changes. Please pull first.`);
      console.log('');
      return;
    }else{

      const remoteFiles = new Map<string, { id: string, type: 'doc'|'file'|'folder' }>();
      const projectInfo = await client.getProjectInfo(projectId);

      if (projectInfo && projectInfo.rootFolder && projectInfo.rootFolder[0]) {
        function buildFileMap(folder: any, currentPath: string = '') {
          for (const doc of folder.docs || []) {
            remoteFiles.set(currentPath ? `${currentPath}/${doc.name}` : doc.name, { id: doc._id, type: 'doc' });
          }
          for (const file of folder.fileRefs || []) {
            remoteFiles.set(currentPath ? `${currentPath}/${file.name}` : file.name, { id: file._id, type: 'file' });
          }
          for (const sub of folder.folders || []) {
            const subPath = currentPath ? `${currentPath}/${sub.name}` : sub.name;
            remoteFiles.set(subPath, { id: sub._id, type: 'folder' });
            buildFileMap(sub, subPath);
          }
        }
        buildFileMap(projectInfo.rootFolder[0]);
      }

      let folderTree = await client.getFolderTreeFromSocket(projectId);
      if (!folderTree) folderTree = {};

      for (const hash of commits) {
        const commitMsg = execSync(`git show -s --format=%s ${hash}`, { encoding: 'utf8' }).trim();

        const uploadStr = execSync(`git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r ${hash}`, { encoding: 'utf8' }).trim();
        const filesToUpload = uploadStr ? uploadStr.split('\n') : [];

        const deleteStr = execSync(`git diff-tree --no-commit-id --name-only --diff-filter=D -r ${hash}`, { encoding: 'utf8' }).trim();
        const filesToDelete = deleteStr ? deleteStr.split('\n') : [];

        for (const file of filesToUpload) {
          if ( file !== ".gitignore") {
            try {
              const content = execSync(`git show ${hash}:"${file}"`, { encoding: 'buffer' });
              await client.uploadFile(projectId!, null, file, content, folderTree);
            } catch (error: any) {
              console.log(`error ${refToUpdate} Failed to upload ${file}: ${error.message}`);
            }
          }
        }

        for (const file of filesToDelete) {
          const entity = remoteFiles.get(file);
          if (!entity) {
            console.log(`error ${refToUpdate} Failed to delete ${file}: Does not exist remotely`);
          }else{
            try {
              await client.deleteEntity(projectId!, entity.id, entity.type);
            } catch (error: any) {
              console.log(`error ${refToUpdate} Failed to delete ${file}: ${error.message}`);
            }
          }
        }
        if(filesToDelete.length > 0) {
          const folderEntries = Array.from(remoteFiles.entries())
          .filter(([path, entity]) => entity.type === 'folder');

          folderEntries.sort(([pathA], [pathB]) => pathB.split('/').length - pathA.split('/').length);

          for (const [folderPath, entity] of folderEntries) {
            const folderPrefix = folderPath + '/';

            // Check if ANY key left in the map starts with this folder's path
            if (! Array.from(remoteFiles.keys()).some(
              key => key.startsWith(folderPrefix)
            )) {

              try {
                await client.deleteEntity(projectId, entity.id, 'folder');
                remoteFiles.delete(folderPath);
              } catch (e) {
                console.log(`error ${refToUpdate} Failed to delete folder ${folderPath}`);
              }
            }
          }
        }

        /*
           try {

           const project = await client.getProjectInfo(projectId);

        //console.error(project.version);
        await client.applyOverleafLabel(projectId, commitMsg, project.version || 0);

        } catch (err: any) {
        console.error(`  -> Warning: Failed to apply label '${commitMsg}'`);
        }
        */
      }

      // Getting new last updated time from overleaf
      let project = await client.getProjectById(projectId);
      if (!project) project = await client.getProject(projectId);
      if (!project) {
        console.log(`error ${refToUpdate} Could not find project : ${projectId}`);
        return;
      }
      const overleafTime = Math.floor(new Date(project.lastUpdated).getTime() / 1000);

      setLastSyncTime(overleafTime);

      console.log(`ok ${refToUpdate}`);
      console.log('');
    }

  } catch (error: any) {
    console.log(`error ${refToUpdate} Push failed: ${error.message}`);
    console.log('');
  }
}

/*
 * Function handling the import request from git-remote-helper
 */
async function runImport(refToUpdate:  string){
  let tempDir = '';
  try {
    const client = await getClient();

    let project = await client.getProjectById(projectId);
    if (!project) project = await client.getProject(projectId);
    if (!project) {
      console.error(`\n[olcli] Error: Could not find project '${projectId}'`);
      process.exit(1);
    }
    const overleafTime = Math.floor(new Date(project.lastUpdated).getTime() / 1000);
    const localTime = getLastSyncTime();
    const hasLocalHistory = localTime > 0;

    //Checking if pulling is necessary
    if (overleafTime === localTime) {

      const localHash = getLocalCommitHash(refToUpdate);

      process.stdout.write(`feature done\n`);
      process.stdout.write(`reset ${refToUpdate}\n`);
      process.stdout.write(`from ${localHash}\n`);
      process.stdout.write(`done\n`, () => {
        console.log('');
      });
    }else{
      //Downloading the zip file
      const zipBuffer = await client.downloadProject(projectId);

      tempDir = mkdtempSync(join(tmpdir(), 'overleaf-sync-'));
      const zipPath = join(tempDir, 'project.zip');
      const extractDir = join(tempDir, 'extracted');

      writeFileSync(zipPath, zipBuffer);
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractDir, true);

      function getFilesToImport(dir: string, fileList: string[] = []) {
        const items = readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const fullPath = join(dir, item.name);
          if (item.isDirectory()) {
            getFilesToImport(fullPath, fileList);
          } else {
            fileList.push(fullPath);
          }
        }
        return fileList;
      }

      const files = getFilesToImport(extractDir);
      const timestamp = overleafTime;
      const commitMsg = "Sync from Overleaf\n";



      let streamData = '';
      streamData += `commit ${refToUpdate}\n`;
      streamData += `mark :1\n`;
      streamData += `author Overleaf Sync <sync@overleaf.com> ${timestamp} +0000\n`;
      streamData += `committer Overleaf Sync <sync@overleaf.com> ${timestamp} +0000\n`;
      streamData += `data ${Buffer.byteLength(commitMsg, 'utf8')}\n`;
      streamData += commitMsg;

      if (hasLocalHistory) {
        streamData += `from ${refToUpdate}^0\n`;
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

      process.stdout.write(`done\n`, () => {
        console.log('');
      });


      //Setting the time locally
      setLastSyncTime(overleafTime);
    }

  } catch (error: any) {
    console.error(`\n[olcli] Error fetching from Overleaf: ${error.message}`);
    process.exit(1);
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function getLocalCommitHash(ref: string): string {
  try {
    return execSync(`git rev-parse ${ref}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
function getLastSyncTime(): number {
  try {
    const out = execSync(`git config overleaf.lastsync`, { encoding: 'utf8' });
    return parseInt(out.trim(), 10);
  } catch {
    return 0; // Returns 0 if we've never synced before
  }
}

function setLastSyncTime(timestamp: number) {
  execSync(`git config overleaf.lastsync ${timestamp}`);
}
