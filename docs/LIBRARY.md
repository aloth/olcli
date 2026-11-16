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
  // Tracked changes and suggestions
  TrackedChange, ListTrackedChangesOptions, ProjectReview, RejectConflictError,
  SuggestionEdit, SuggestionResult, SuggestionOutcome, SuggestionPlan, SuggestionPermissionError,
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

## Turning pushed edits into suggestions (experimental)

`client.suggestChanges(projectId, path, edits)` turns edits that are already on Overleaf as plain text, for example pushed through git, `olcli push` or a sync, into tracked changes that collaborators can accept or reject. Each edit is `{ before, deleted, inserted, after, hint? }`: the old and the new text with some unchanged text around it, and optionally the approximate offset of the edit; the nearest match wins. `client.planSuggestions(projectId, path, edits)` reports what would happen without writing.

```ts
const results = await client.suggestChanges(projectId, 'main.tex', [
  { before: 'The ', deleted: 'quick', inserted: 'slow', after: ' fox', hint: 120 },
]);
// ['done']
```

This method is experimental:

- Only documents in the `sharejs-text-ot` format are supported; `history-ot` documents are refused with an error.
- Each edit is undone without tracking and redone with tracking. The text ends up the same, but collaborators who have the document open see the old text for a short moment, about 0.2 seconds.
- The account needs edit access to the project. Review-only access cannot send the untracked undo, so the call throws `SuggestionPermissionError` before writing anything.

One result per edit, in order:

| Result | Meaning |
|--------|---------|
| `done` | Now a tracked change, checked by reading the document again |
| `already-tracked` | The edit is already a tracked change, for example from an earlier call; nothing was sent |
| `not-pushed` | Overleaf still has the old text; nothing was sent |
| `not-found` | Neither the old nor the new text is there; nothing was sent |
| `unchanged` | `inserted` equals `deleted`; nothing was sent |
| `invalid` | `before`, `inserted` and `after` are all empty, so the edit cannot be found; nothing was sent |
| `not-tracked` | The edit was sent, but no tracked change showed up when the document was read again. The text is as before the call |
