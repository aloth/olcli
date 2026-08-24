# MCP Server

`@aloth/olcli` ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server so AI assistants like **Claude Desktop**, **Cursor**, and **Windsurf** can interact with your Overleaf projects directly.

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_projects` | List all Overleaf projects |
| `get_project_info` | Get file tree and metadata for a project |
| `pull_project` | Download and extract a project to a local directory |
| `push_file` | Upload a local file to a project |
| `compile` | Compile a project and get the PDF URL |
| `download_pdf` | Compile a project and save the PDF locally |
| `list_comments` | List review comments (filter: all / open / resolved) |
| `get_entities` | Get a flat list of all files in a project |
| `download_file` | Download a specific file by its remote path |
| `add_comment` | Add a review comment to a document |
| `reply_to_comment` | Reply to an existing comment thread |
| `resolve_comment` | Mark a comment thread as resolved |
| `delete_entity` | Delete a file or document by path |
| `rename_entity` | Rename a file or document |
| `rename_project` | Rename the project itself (not a file inside it) |
| `plan_project_renames` | Preview a bulk project rename — **plan only, never applies** |
| `compile_with_outputs` | Compile and return all output files (PDF, BBL, logs…) |

> **Why `plan_project_renames` cannot apply.** A bulk rename across an account is unrecoverable: Overleaf keeps no project-name history, and it tolerates duplicate names, so a bad pattern succeeds silently and leaves projects nobody can tell apart. The tool returns the planned renames, skipped projects and any collisions; executing them requires a human running `olcli project rename-bulk --apply` in a terminal.

## Authentication

The MCP server reads credentials in this order:

1. **`OVERLEAF_SESSION` environment variable** — set in your MCP config (recommended)
2. **`OVERLEAF_EMAIL` + `OVERLEAF_PASSWORD` environment variables** — for password login (self-hosted)
3. **`.olauth` file in cwd** — written by `olcli auth`
4. **Stored config** — written by `olcli auth` (including saved password credentials)

When a session cookie expires and password credentials are available, the MCP server automatically re-authenticates.

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "@aloth/olcli-mcp"],
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
      "args": ["-y", "@aloth/olcli-mcp"],
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
      "args": ["-y", "@aloth/olcli-mcp"],
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
3. Find `overleaf_session2` (or `sharelatex.sid` for self-hosted)
4. Copy the value — that's your `OVERLEAF_SESSION`

Or run `olcli auth` and then the MCP server will pick it up automatically.

## Self-hosted Overleaf

Set `OVERLEAF_BASE_URL` in your MCP env:

```json
"env": {
  "OVERLEAF_SESSION": "<cookie>",
  "OVERLEAF_BASE_URL": "https://overleaf.yourcompany.com"
}
```
