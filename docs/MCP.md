# MCP Server

`@xyin-anl/olcli` ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server so AI assistants like **Claude Desktop**, **Cursor**, and **Windsurf** can interact with your Overleaf projects directly.

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
| `get_changes_capabilities` | Inspect a document's native tracked-change capabilities (read-only) |
| `list_tracked_changes` | List native tracked changes with source locations (read-only) |
| `list_history` | List normalized native project-history update groups (read-only) |
| `diff_history` | Diff one file between native history versions (read-only) |
| `get_mcp_review_policy` | Show the effective review mutation policy |
| `preview_tracked_change` | Preview one targeted native suggestion (read-only) |
| `inspect_tracked_document` | Read text-free version/hash preconditions |
| `suggest_tracked_change` | Preview or create one preconditioned native suggestion |
| `accept_tracked_changes` | Preview or accept explicit native change IDs |
| `reject_tracked_changes` | Preview or reject explicit native change IDs |
| `address_review_comment` | Preview or link a suggestion and reply to a comment |
| `review_status` | Read the local text-free review ledger |
| `reconcile_review` | Preview or reconcile ledger state against Overleaf |
| `get_entities` | Get a flat list of all files in a project |
| `download_file` | Download a specific file by its remote path |
| `add_comment` | Add a review comment to a document |
| `reply_to_comment` | Reply to an existing comment thread |
| `resolve_comment` | Mark a comment thread as resolved |
| `delete_entity` | Delete a file or document by path |
| `rename_entity` | Rename a file or document |
| `compile_with_outputs` | Compile and return all output files (PDF, BBL, logs…) |

Tracked-change mutations are preview-first and controlled by
`OLCLI_MCP_REVIEW_MODE`. Mutation-shaped tools default `dry_run` to `true` and
require both the document OT version and source SHA-256 returned by a fresh
preview. Results from actual suggestions and accept/reject operations include
verification state. They also require `OLCLI_EXPERIMENTAL_REVIEW=1`.

History versions are neither Git commits nor document OT versions. The
`diff_history` tool defaults `include_content` and `include_unchanged` to
`false`, so manuscript text is returned only when a caller explicitly opts in.
History restoration is not exposed. See [HISTORY.md](HISTORY.md).

The CLI, library, and MCP tools share the durable `review address`, `review
status`, and `review reconcile` service described in
[REVIEW-WORKFLOW.md](REVIEW-WORKFLOW.md). MCP exposes it through the policy and
precondition boundary below.

## Review mutation policy

The default is least privilege:

```text
OLCLI_MCP_REVIEW_MODE=read
```

| Mode | Allowed Overleaf actions |
|------|--------------------------|
| `read` | List, inspect, diff, preview, compile, and download |
| `suggest` | Everything in `read`, plus native tracked suggestions and comment replies |
| `full` | Everything in `suggest`, plus accept/reject, comment resolution, uploads, new comments, renames, and deletes |

An invalid value fails server startup. A denied call returns the stable
`MCP_REVIEW_POLICY_DENIED` error before authentication or mutation. The older
`push_file`, `add_comment`, `reply_to_comment`, `resolve_comment`,
`delete_entity`, and `rename_entity` tools use the same policy, so they cannot
bypass the tracked-review boundary.

Use `suggest` for an agent that should address reviewer comments while leaving
acceptance and resolution to collaborators:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "olcli-mcp",
      "env": {
        "OVERLEAF_SESSION": "<session-cookie>",
        "OLCLI_EXPERIMENTAL_REVIEW": "1",
        "OLCLI_MCP_REVIEW_MODE": "suggest"
      }
    }
  }
}
```

Use `full` only for a dedicated account and project scope where the agent is
explicitly authorized to accept/reject or perform general project mutations.
The session cookie remains equivalent to account access; do not place it in a
repository, prompt, log, or command-line argument.

### Safe agent sequence

1. Call `get_mcp_review_policy`, `list_comments`, and
   `get_changes_capabilities`.
2. Call `preview_tracked_change` for the exact targeted replacement.
3. Pass its `version` and `textSha256` to `address_review_comment` as
   `expected_version` and `expected_text_sha256`, initially with
   `dry_run: true`.
4. Review that linked preview, then repeat it with `dry_run: false` and the
   same operation UUID and preconditions.
5. Require verification and state-restoration success, compile, then re-list
   the change IDs and comment state.

`address_review_comment` additionally requires a stable UUID `operation_id` so
retries can resume safely. In `suggest` mode its `resolution_policy` must be
`never`; automatic resolution requires `full`.

## Authentication

The MCP server reads credentials in this order:

1. **`OVERLEAF_SESSION` environment variable** — set in your MCP config (recommended)
2. **`OVERLEAF_EMAIL` + `OVERLEAF_PASSWORD` environment variables** — for password login (self-hosted)
3. **`.olauth` file in cwd** — written by `olcli auth`
4. **Stored config** — written by `olcli auth` (including saved password credentials)

When a session cookie expires and password credentials are available, the MCP server automatically re-authenticates.

## Current local checkout

The experimental package is not published yet. For the current repository and
its gitignored `.olauth`, configure an stdio client to start the server from the
repository root:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "zsh",
      "args": [
        "-lc",
        "cd /absolute/path/to/olcli && exec node dist/mcp.js"
      ],
      "env": {
        "OLCLI_EXPERIMENTAL_REVIEW": "1",
        "OLCLI_MCP_REVIEW_MODE": "suggest"
      }
    }
  }
}
```

Run `npm ci && npm run build` in the repository first. Replace
`/absolute/path/to/olcli` with this checkout's absolute path.

## Published-package configuration

The following `npx` examples apply after `@xyin-anl/olcli` is published under
the experimental npm tag.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "--package", "@xyin-anl/olcli@experimental", "olcli-mcp"],
      "env": {
        "OVERLEAF_SESSION": "<your-overleaf-session-cookie>"
      }
    }
  }
}
```

Or if you have the fork installed globally (`npm install -g @xyin-anl/olcli@experimental`):

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

### Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json` or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "--package", "@xyin-anl/olcli@experimental", "olcli-mcp"],
      "env": {
        "OVERLEAF_SESSION": "<your-overleaf-session-cookie>"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "--package", "@xyin-anl/olcli@experimental", "olcli-mcp"],
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
