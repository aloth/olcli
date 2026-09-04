# Architecture

Orientation for anyone about to open `src/client.ts` and wonder why it looks
like that. For setup and pull request mechanics, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## The premise: there is no Overleaf API

Overleaf publishes no REST API for the free tier. olcli is not an API client —
it **authenticates as a logged-in browser session and calls the same endpoints
the web editor's own JavaScript calls.**

Almost every design decision follows from that one fact:

- Authentication is a session cookie, because that is what a browser holds.
- Reading project data means parsing Overleaf's HTML, because that is where a
  server-rendered page puts it.
- Write endpoints are whatever the web editor posts to.
- Nothing is versioned or documented, so **anything here can break when
  Overleaf ships a redesign.** The layered fallbacks scattered through
  `client.ts` are not defensive habit; each one is a redesign that already
  happened.

Requests carry a `User-Agent` of `olcli/<version>`. olcli does not pretend to
be Chrome — the session is a real one belonging to the user running it.

## Authentication

Two ways in, both ending at the same place:

| Entry point | What it does |
|---|---|
| `OverleafClient.fromSessionCookie()` | Takes a cookie the user copied from their browser |
| `OverleafClient.fromPasswordLogin()` | Submits the login form (self-hosted instances without reCAPTCHA) |

Both then need a second credential. Overleaf requires a **CSRF token** on every
state-changing request, which is what stops another site using your cookie
against it. The token is not secret — the web editor needs it in the page to
make its own requests — so olcli fetches a page with the cookie and reads the
token out of the HTML (`extractCsrfToken`). From then on every request carries
both:

```
Cookie: overleaf_session2=...
X-Csrf-Token: ...
```

`applySetCookieHeaders()` folds any `Set-Cookie` from each response back into
the in-memory jar, so a session that rotates mid-run keeps working — the same
bookkeeping a browser does.

Credential *storage* lives in `src/config.ts`, deliberately apart from the
client: env var, then `.olauth` in the current directory, then the global
config file. The client itself never reads any of them.

## Reading: HTML scraping, then Socket.IO

Project data is server-rendered into `<meta name="ol-*">` tags, so
`listProjects()` and `getProjectInfo()` parse the page with `cheerio`. Each has
several fallbacks tried in order, because the tag names and shapes have changed
more than once.

The file tree is the awkward one. It used to live in `ol-project`; it no longer
does. `getProjectFromSocket()` recovers it by **speaking Socket.IO 0.9 by
hand** — handshake for a session id, `xhr-polling` for packets, decode the
frames, answer the `2::` heartbeats, and pull the tree out of the
`joinProjectResponse` event.

This is the most fragile surface in the repository, and the least
self-evident. It is also unavoidable: that payload is where the tree is now.
Results are cached per project in `folderTreeCache` so a multi-file upload
does not repeat the whole dance for every file.

## Writing: upload replaces, it does not edit

| Operation | Request |
|---|---|
| Read all files | `GET /project/<id>/download/zip` |
| Write a file | `POST /project/<id>/upload?folder_id=<id>` (multipart, field `qqfile`) |
| Delete | `DELETE /project/<id>/{doc,file,folder}/<entityId>` |
| Rename an entity | `POST /project/<id>/<type>/<entityId>/rename` |
| Rename the project | `POST /project/<id>/rename` |
| Compile | `POST /project/<id>/compile` |

**The most important thing to understand about writes:** typing in the Overleaf
editor sends character-level operations over the collaboration socket — an
operational transform stream that merges concurrent edits. `uploadFile()` does
not do that. It posts a whole file to the upload endpoint, exactly as if you
had dragged a same-named file into the web UI.

So a `push` **overwrites**. It does not merge, and it cannot: there is no
three-way merge to perform, only a file replacing a file. That is why
`olcli diff` exists — previewing what a push will overwrite is the only
protection against a collaborator's edit being replaced — and why `diff`
fetches the remote fresh rather than comparing against the last pull.

Reading the whole project is one request, not one per file: `downloadProject()`
returns the entire project as a zip. `pull`, `sync` and `diff` all use it.

## The transport

Everything goes through one private method, `httpRequest()`, built on
`node:http`/`node:https` rather than `fetch`. That is not preference: `fetch`
validates response headers as Latin-1 and throws on a `Content-Disposition`
carrying a non-ASCII project name, which made downloads fail for anyone with an
accented title ([#2](https://github.com/aloth/olcli/issues/2)). It also handles
redirects, timeouts, and serialising `FormData` into a multipart body.

`--verbose` makes it log every request and response to stderr, which is the
first thing to reach for when Overleaf changes something.

## Module map

Which files need an Overleaf account to exercise, and which do not. This is the
main thing to know before adding a feature, because it decides where the logic
should go.

**Pure — data in, data out. No network, no filesystem, unit-tested:**

| Module | Responsibility |
|---|---|
| `diff.ts` | Compare two file trees; render unified diffs |
| `ignore.ts` | The three ignore layers and the `.pdf`-next-to-`.tex` rule |
| `paths.ts` | Remote path normalisation; zip-slip containment |
| `rename-plan.ts` | Plan bulk project renames before applying any |
| `prompt.ts` | Keystroke handling for the password prompt |
| `scan.ts` | Walk a local directory, applying ignore rules |

**Talks to Overleaf:**

| Module | Responsibility |
|---|---|
| `client.ts` | Every request. The browser-session model lives here |
| `config.ts` | Credential resolution and storage |

**Entry points, all thin over the two above:**

| Module | Binary |
|---|---|
| `cli.ts` | `olcli` — argument parsing and terminal output |
| `mcp.ts` | `olcli-mcp` — the same operations as MCP tools |
| `remote-helper.ts` | `git-remote-overleaf` — `gitremote-helpers(7)` protocol |
| `index.ts` | The programmatic API re-exported from the package root |

New logic belongs in the pure column wherever it can go. That is why `scan.ts`
exists at all: `push` and `sync` each carried their own copy of the same walk
loop and had already drifted apart, and `diff` would have made a third. The
same reasoning produced `rename-plan.ts` and `diff.ts`.

`client.ts` request *construction* can also be tested without an account, by
pointing the client at a local HTTP server that captures the outgoing request —
see `test/client.test.ts`.

## When Overleaf breaks it

The usual failure is a redesign moving data somewhere else. Reliable order:

1. `olcli --verbose <command>` — see the actual request and response.
2. If a page parse returns nothing, fetch the page in a browser with devtools
   and look for the `ol-*` meta tag. Add a fallback; keep the existing ones,
   since self-hosted instances run older versions.
3. If the file tree is what broke, suspect `getProjectFromSocket()` first.
4. `olcli check` reports which credential source is in play, without printing
   any secret.
