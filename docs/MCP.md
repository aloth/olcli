# MCP Server

`@aloth/olcli` ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server so AI assistants like **Claude Desktop**, **Cursor**, and **Windsurf** can interact with your Overleaf projects directly.

## MCP Tools

Tools marked "asks first" change the Overleaf project. Before writing, the server asks you to confirm in the MCP client; see [Write confirmation](#write-confirmation).

| Tool | Description |
|------|-------------|
| `list_projects` | List all Overleaf projects |
| `get_project_info` | Get file tree and metadata for a project |
| `pull_project` | Download and extract a project to a local directory |
| `push_file` | Upload a local file to a project; asks first |
| `compile` | Compile a project and get the PDF URL |
| `download_pdf` | Compile a project and save the PDF locally |
| `list_comments` | List review comments (filter: all / open / resolved); with `include_changes` also tracked changes, returned as `{ comments, changes }` |
| `get_entities` | Get a flat list of all files in a project |
| `download_file` | Download a specific file by its remote path |
| `add_comment` | Add a review comment to a document; asks first |
| `reply_to_comment` | Reply to an existing comment thread; asks first |
| `resolve_comment` | Mark a comment thread as resolved; asks first |
| `accept_tracked_changes` | Accept tracked changes by id; sends nothing if any id is unknown; asks first |
| `reject_tracked_changes` | Reject tracked changes by id; returns a diff preview and writes only with `apply: true`, after asking |
| `delete_entity` | Delete a file or document by path; asks first |
| `rename_entity` | Rename a file or document; asks first |
| `rename_project` | Rename the project itself (not a file inside it); asks first |
| `plan_project_renames` | Preview a bulk project rename — **plan only, never applies** |
| `compile_with_outputs` | Compile and return all output files (PDF, BBL, logs…) |
| `diff_project` | Content-level diff of a local directory against the live remote — **read-only** |
| `create_project` | Create a new blank or example project; asks first |

> **Tracked changes need a premium project.** Track changes is an Overleaf premium feature: it is only available in projects whose owner has a premium plan, and invited collaborators can then use it regardless of their own plan. In other projects `list_comments` with `include_changes` returns no changes and `accept_tracked_changes`/`reject_tracked_changes` report the ids as not found. See the [Overleaf documentation](https://docs.overleaf.com/collaborating/track-changes).

> **What `diff_project` compares.** The remote side is fetched fresh on every call, so the result describes the project as it is right now, which is what a later push would overwrite. It is not a comparison against the last pull: the manifest records remote paths, never remote contents, so there is no stored snapshot. Every response carries `remote_fetched_at` for that reason — a collaborator editing between the call and a push can still change the outcome. Patches are oriented `a/` = remote, `b/` = local, so a `+` line is content a push would upload. Pass `name_only` to get statuses without patch text.

> **Why `plan_project_renames` cannot apply.** A bulk rename across an account is unrecoverable: Overleaf keeps no project-name history, and it tolerates duplicate names, so a bad pattern succeeds silently and leaves projects nobody can tell apart. The tool returns the planned renames, skipped projects and any collisions; executing them requires a human running `olcli project rename-bulk --apply` in a terminal.

## Write confirmation

Document text, comments and replies, tracked changes, and file and project names are written by project collaborators, and the MCP tools return them to the assistant as they are. Text placed there can try to instruct the assistant, for example a comment asking it to delete a file or accept every suggestion. Hiding that content would make review impossible, so the check sits outside the assistant: before a tool changes a project, the MCP server asks you directly through [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) and writes only if you confirm. The assistant cannot answer the dialog for you.

The server also tells the client, in its MCP `instructions` and in the descriptions of the tools that return project content, that this content is data and not instructions. `list_comments` repeats this as a second text block after its JSON result. That is guidance for the assistant; the confirmation is the part that does not depend on the assistant following it.

### Which tools ask

| Tool | The dialog shows |
|------|------------------|
| `push_file` | Local file, size, target path in the project, and whether it replaces an existing file. For an existing text document also a diff against the current file on Overleaf |
| `delete_entity` | The path that will be deleted and whether it is a doc, a file, or a folder |
| `rename_entity` | Old and new path |
| `rename_project` | Old and new project name. If the name does not change, nothing is asked and nothing is written |
| `create_project` | Name and template |
| `add_comment` | Document, where the comment is anchored, and the exact comment text |
| `reply_to_comment` | The thread (location, commented text, messages) and the exact reply text |
| `resolve_comment` | The thread |
| `accept_tracked_changes` | Each change as `path:line:column`, kind, author, and text, plus a diff of what becomes final: the text without the selected suggestions against the text after accepting them. Other tracked changes in the same document stay pending and are shown as not applied on both sides |
| `reject_tracked_changes` with `apply: true` | Each change and the rejection diff. With `apply: false` (the default) it returns the preview and asks nothing |

The dialog has one checkbox, "Confirm", which starts unchecked. Only accepting with the box checked writes. Declining, dismissing the dialog, submitting it unchecked, no answer within 10 minutes (or the client canceling the call sooner), or an error all write nothing, and the tool result tells the assistant that the change was not made and why.

Long content is cut with an explicit note such as `... 12 more lines not shown`. Control characters, zero-width characters, and bidirectional formatting characters are shown as `\u{...}`, so text cannot look different from what it is.

What you confirm is what gets written: `delete_entity` and `rename_entity` act on the entity shown in the dialog, `reject_tracked_changes` refuses to write if a document changed after the preview, and `accept_tracked_changes` refuses if a selected change no longer has the text shown.

Tools that only read never ask. `pull_project`, `download_file`, and `download_pdf` write local files but do not change the Overleaf project, and do not ask either. `plan_project_renames` never applies anything.

### Clients without elicitation

Whether the dialog appears depends on the MCP client: it has to support elicitation in form mode and declare the capability when it connects. If it does not, olcli cannot ask you, so the tools above write nothing. Instead the result contains:

- `preview`: the text the dialog would have shown, plus the same details as structured fields
- `cli_command`: the `olcli` command that makes the same change from a terminal, for example `olcli changes accept --project <project-id> <change-id>`
- `opt_out_env`: the environment variable described below

Run `cli_command` yourself in a terminal where olcli is signed in to the same account. It uses the CLI's own stored credentials, not the MCP server's environment.

### Opting out

Setting `OLCLI_MCP_UNCONFIRMED_WRITES=1` in the server environment restores the behavior of olcli 0.15.0: the tools write without olcli asking, and the only check left is the client's own tool approval, if it has one. It also skips the dialog in clients that do support elicitation. `1`, `true`, and `yes` turn confirmation off; any other value keeps it on.

```json
"env": {
  "OVERLEAF_SESSION": "<cookie>",
  "OLCLI_MCP_UNCONFIRMED_WRITES": "1"
}
```

### Tool annotations

Every tool declares MCP tool annotations. Read-only tools set `readOnlyHint`. Tools that overwrite, delete, or finalize something set `destructiveHint`: `push_file`, `delete_entity`, `rename_entity`, `rename_project`, `accept_tracked_changes`, `reject_tracked_changes`, and the local-file tools `pull_project`, `download_file`, and `download_pdf`. `idempotentHint` is set where repeating a call with the same arguments has no further effect, and `openWorldHint` is set on all tools because they talk to Overleaf. Clients may use the annotations to decide which calls need approval. They are hints and do not replace the confirmation.

## Authentication

The MCP server reads credentials in this order:

1. **`OVERLEAF_SESSION` environment variable** — set in your MCP config (recommended)
2. **`OVERLEAF_EMAIL` + `OVERLEAF_PASSWORD` environment variables** — for password login (self-hosted)
3. **`.olauth` file in cwd** — written by `olcli auth --save-local`
4. **Stored config** — written by `olcli auth` (including saved password credentials)

When a session cookie expires and password credentials are available, the MCP server automatically re-authenticates.

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "--package", "@aloth/olcli", "olcli-mcp"],
      "env": {
        "OVERLEAF_SESSION": "<your-overleaf-session-cookie>"
      }
    }
  }
}
```

Or if you have olcli installed globally (`npm install -g @aloth/olcli`):

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "olcli-mcp",
      "env": {
        "OVERLEAF_SESSION": "<your-overleaf-session-cookie>"
      }
    }
  }
}
```

## Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json` or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "--package", "@aloth/olcli", "olcli-mcp"],
      "env": {
        "OVERLEAF_SESSION": "<your-overleaf-session-cookie>"
      }
    }
  }
}
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "--package", "@aloth/olcli", "olcli-mcp"],
      "env": {
        "OVERLEAF_SESSION": "<your-overleaf-session-cookie>"
      }
    }
  }
}
```

## Getting Your Session Cookie

1. Open Overleaf in your browser and log in
2. Open DevTools → Application (Chrome) or Storage (Firefox) → Cookies
3. Find `overleaf_session2` on overleaf.com, or `overleaf.sid` on self-hosted Overleaf (very old self-hosted versions use `sharelatex.sid`)
4. Copy the value — that's your `OVERLEAF_SESSION`

Or run `olcli auth` and then the MCP server will pick it up automatically.

## Self-hosted Overleaf

Set `OVERLEAF_BASE_URL` in your MCP env. If your instance names its session cookie `overleaf.sid` (or `sharelatex.sid`) instead of `overleaf_session2`, set `OVERLEAF_COOKIE_NAME` to that name as well:

```json
"env": {
  "OVERLEAF_SESSION": "<cookie>",
  "OVERLEAF_BASE_URL": "https://overleaf.yourcompany.com",
  "OVERLEAF_COOKIE_NAME": "overleaf.sid"
}
```

`list_comments` fetches up to 4 documents in parallel; set `OLCLI_CONCURRENCY` to a value from 1 to 8 to change that.
