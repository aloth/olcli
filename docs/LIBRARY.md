# Library API

`@aloth/olcli` exposes `OverleafClient` and all public interfaces as a TypeScript library.

## Install

```bash
npm install @aloth/olcli
```

## Basic example

```ts
import { readFileSync } from 'node:fs';
import { OverleafClient } from '@aloth/olcli';

const client = await OverleafClient.fromSessionCookie(cookie);

const created = await client.createProject('My Paper');
const projects = await client.listProjects();
const info = await client.getProjectInfo(projectId);
const zipBuf = await client.downloadProject(projectId);
const pdfBuf = await client.downloadPdf(projectId);

await client.uploadFile(projectId, null, 'main.tex', readFileSync('main.tex'));

const comments = await client.listComments(projectId, { status: 'open' });
```

## Available exports

```ts
import {
  OverleafClient,
  // Types
  Project, ProjectInfo, ProjectTemplate, CreateProjectOptions, CreatedProject,
  FolderEntry, DocEntry, FileEntry,
  CommentMessage, ProjectComment, CommentContext, CommentStatus,
  ListCommentsOptions, AddCommentOptions, Credentials, SessionCookiePair,
  // Config utilities
  getBaseUrl, setBaseUrl, getSessionCookie, setSessionCookie,
  getSessionCookieName, setSessionCookieName, getCsrf, setCsrf,
  getLastProject, setLastProject, clearConfig, getConfigPath, saveOlAuth,
  getTimeout, setTimeout, getPasswordCredentials, setPasswordCredentials,
  clearPasswordCredentials, type PasswordCredentials,
  // Ignore utilities
  DEFAULT_IGNORE_PATTERNS, loadIgnore, shouldIgnore, buildTexSiblingSet,
  IgnoreContext, LoadIgnoreOptions,
} from '@aloth/olcli';
```
