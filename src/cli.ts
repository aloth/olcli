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
import {
  getSessionCookie,
  setSessionCookie,
  getLastProject,
  setLastProject,
  getConfigPath,
  saveOlAuth,
  clearConfig
} from './config.js';

const program = new Command();

program
  .name('olcli')
  .description('Overleaf CLI - interact with Overleaf projects from the command line')
  .version('0.1.0');

/**
 * Helper to get authenticated client
 */
async function getClient(cookieOpt?: string): Promise<OverleafClient> {
  const cookie = cookieOpt || getSessionCookie();
  if (!cookie) {
    console.error(chalk.red('No session cookie found.'));
    console.error('Set one with: olcli auth --cookie <session_cookie>');
    console.error('Or set OVERLEAF_SESSION environment variable');
    console.error('Or create .olauth file in current directory');
    process.exit(1);
  }
  return OverleafClient.fromSessionCookie(cookie);
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
  .description('Authenticate with Overleaf using session cookie')
  .option('--cookie <session>', 'Session cookie (overleaf_session2 value)')
  .option('--save-local', 'Save to .olauth in current directory')
  .action(async (options) => {
    if (!options.cookie) {
      console.log(chalk.yellow('To authenticate, provide your session cookie:'));
      console.log();
      console.log('1. Log into overleaf.com in your browser');
      console.log('2. Open Developer Tools (F12) → Application → Cookies');
      console.log('3. Find the cookie named "overleaf_session2"');
      console.log('4. Copy its value and run:');
      console.log();
      console.log(chalk.cyan('  olcli auth --cookie "your_session_cookie_value"'));
      console.log();
      console.log('Or set OVERLEAF_SESSION environment variable');
      return;
    }

    const spinner = ora('Verifying session...').start();
    try {
      const client = await OverleafClient.fromSessionCookie(options.cookie);
      const projects = await client.listProjects();

      setSessionCookie(options.cookie);

      if (options.saveLocal) {
        saveOlAuth(options.cookie);
        spinner.succeed(`Authenticated! Found ${projects.length} projects. Saved to .olauth`);
      } else {
        spinner.succeed(`Authenticated! Found ${projects.length} projects.`);
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
      const client = await OverleafClient.fromSessionCookie(cookie);
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
      const fileName = basename(file);

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

// NOTE: delete and rename commands are disabled - they require entity IDs
// which are not exposed via the current Overleaf API without Socket.IO.
// Use the Overleaf web UI for these operations.
//
// program
//   .command('delete <file> [project]')
//   .alias('rm')
//   .description('Delete a file from a project')
//   .option('--cookie <session>', 'Session cookie override')
//   .action(async (file, project, options) => {
//     const spinner = ora('Deleting file...').start();
//     try {
//       const client = await getClient(options.cookie);
//       const proj = await resolveProject(client, project);
//       await client.deleteByPath(proj.id, file);
//       spinner.succeed(`Deleted: ${file}`);
//       setLastProject(proj.id);
//     } catch (error: any) {
//       spinner.fail(`Failed: ${error.message}`);
//       process.exit(1);
//     }
//   });
//
// program
//   .command('rename <oldname> <newname> [project]')
//   .alias('mv')
//   .description('Rename a file in a project')
//   .option('--cookie <session>', 'Session cookie override')
//   .action(async (oldname, newname, project, options) => {
//     const spinner = ora('Renaming file...').start();
//     try {
//       const client = await getClient(options.cookie);
//       const proj = await resolveProject(client, project);
//       await client.renameByPath(proj.id, oldname, newname);
//       spinner.succeed(`Renamed: ${oldname} → ${newname}`);
//       setLastProject(proj.id);
//     } catch (error: any) {
//       spinner.fail(`Failed: ${error.message}`);
//       process.exit(1);
//     }
//   });

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

      // Save project metadata
      writeFileSync(join(targetDir, '.olcli.json'), JSON.stringify({
        projectId,
        projectName,
        lastPull: new Date().toISOString()
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
  .option('--cookie <session>', 'Session cookie override')
  .action(async (dir, options) => {
    const targetDir = dir || '.';
    const metaPath = join(targetDir, '.olcli.json');

    // Check for project metadata
    let projectId: string | undefined;
    let projectName: string | undefined;
    let lastPull: Date | undefined;

    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      projectId = meta.projectId;
      projectName = meta.projectName;
      lastPull = meta.lastPull ? new Date(meta.lastPull) : undefined;
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

      // Get list of files to upload
      const { readdirSync, statSync } = await import('node:fs');

      const filesToUpload: { path: string; relativePath: string }[] = [];

      function scanDir(currentDir: string, relativeBase: string = '') {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          // Skip hidden files and .olcli.json
          if (entry.name.startsWith('.')) continue;

          const fullPath = join(currentDir, entry.name);
          const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            scanDir(fullPath, relativePath);
          } else {
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

      spinner.text = `Uploading ${filesToUpload.length} file(s)...`;

      let uploaded = 0;
      let failed = 0;

      for (const file of filesToUpload) {
        try {
          const content = readFileSync(file.path);
          await client.uploadFile(projectId!, null, file.relativePath, content);
          uploaded++;
          spinner.text = `Uploading... (${uploaded}/${filesToUpload.length})`;
        } catch (error: any) {
          console.error(chalk.yellow(`\n  Warning: Failed to upload ${file.relativePath}: ${error.message}`));
          failed++;
        }
      }

      // Update last pull time
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        meta.lastPush = new Date().toISOString();
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }

      if (failed > 0) {
        spinner.warn(`Uploaded ${uploaded} files, ${failed} failed`);
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
  .description('Pull then push (bidirectional sync)')
  .option('--project <name>', 'Project name or ID')
  .option('--verbose', 'Show detailed file operations')
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

      // Track local modifications
      const localFiles = new Map<string, { mtime: Date; content: Buffer }>();
      const { readdirSync, statSync } = await import('node:fs');

      function scanLocalFiles(currentDir: string, relativeBase: string = '') {
        if (!existsSync(currentDir)) return;
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(currentDir, entry.name);
          const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            scanLocalFiles(fullPath, relativePath);
          } else {
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

      // Extract remote files
      const remoteFiles = new Map<string, Buffer>();
      for (const entry of zip.getEntries()) {
        if (!entry.isDirectory) {
          remoteFiles.set(entry.entryName, entry.getData());
        }
      }

      // Merge: local changes take precedence for files modified after last pull
      let lastPull: Date | undefined;
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        lastPull = meta.lastPull ? new Date(meta.lastPull) : undefined;
      }

      const filesToUpload: { path: string; content: Buffer }[] = [];
      const filesUpdatedLocally: string[] = [];
      const filesKeptLocal: string[] = [];
      const filesNewLocal: string[] = [];

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
        if (!remoteFiles.has(path)) {
          filesToUpload.push({ path, content: localFile.content });
          filesNewLocal.push(path);
        }
      }

      // Upload local changes
      if (filesToUpload.length > 0) {
        spinner.text = `Uploading ${filesToUpload.length} local change(s)...`;
        for (const file of filesToUpload) {
          await client.uploadFile(projectId, null, file.path, file.content);
        }
      }

      // Update metadata
      writeFileSync(metaPath, JSON.stringify({
        projectId,
        projectName,
        lastPull: new Date().toISOString(),
        lastSync: new Date().toISOString()
      }, null, 2));

      spinner.succeed(`Synced "${projectName}"`);

      // Summary
      console.log(chalk.dim(`  ↓ ${filesUpdatedLocally.length} pulled from remote`));
      console.log(chalk.dim(`  ↑ ${filesToUpload.length} pushed to remote`));

      if (options.verbose) {
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

program.parse();
