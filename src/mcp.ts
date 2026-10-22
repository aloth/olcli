#!/usr/bin/env node
/**
 * olcli MCP Server
 *
 * Exposes OverleafClient methods as MCP tools so AI assistants
 * (Claude Desktop, Cursor, Windsurf, …) can manage Overleaf projects.
 *
 * Transport: stdio (standard for Claude Desktop / Cursor / Windsurf)
 *
 * Auth: reads session cookie from OVERLEAF_SESSION env var or .olauth file in cwd.
 *
 * Tools that change a project ask the user to confirm first (MCP
 * elicitation); see mcp-server.ts and mcp-confirm.ts.
 *
 * Start:
 *   npx @aloth/olcli-mcp
 *   node dist/mcp.js
 *   npm run mcp          # (from repo root)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OverleafClient } from './client.js';
import { createOlcliMcpServer } from './mcp-server.js';
import {
  getSessionCookie,
  getBaseUrl,
  getSessionCookieName,
  setSessionCookie,
  setSessionCookieName,
  getPasswordCredentials,
} from './config.js';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Resolve session cookie: env var → .olauth file in cwd → stored config.
 */
function resolveSessionCookie(): string {
  // 1. Explicit environment variable
  if (process.env.OVERLEAF_SESSION) {
    return process.env.OVERLEAF_SESSION.trim();
  }

  // 2. .olauth file in current working directory
  const olauth = join(process.cwd(), '.olauth');
  if (existsSync(olauth)) {
    try {
      const raw = readFileSync(olauth, 'utf-8').trim();
      if (raw) return raw;
    } catch {
      // fall through
    }
  }

  // 3. Stored via `olcli auth` (Conf-based config)
  const stored = getSessionCookie();
  if (stored) return stored;

  throw new Error(
    'No Overleaf session cookie found.\n' +
    'Set OVERLEAF_SESSION=<cookie>, run `olcli auth`, or save password login credentials with `olcli auth --email <email> --password <password>`.'
  );
}

// ---------------------------------------------------------------------------
// Lazy client factory — initialised once, reused across requests
// ---------------------------------------------------------------------------

let _client: OverleafClient | null = null;

async function getClient(): Promise<OverleafClient> {
  if (_client) return _client;
  const baseUrl = process.env.OVERLEAF_BASE_URL ?? getBaseUrl();
  const cookieName = getSessionCookieName();

  try {
    const cookie = resolveSessionCookie();
    _client = await OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
  } catch (error) {
    const credentials = getPasswordCredentials();
    if (!credentials) throw error;

    _client = await OverleafClient.fromPasswordLogin(credentials.email, credentials.password, baseUrl);
    const sessionCookie = _client.getSessionCookiePair(cookieName);
    if (sessionCookie) {
      setSessionCookieName(sessionCookie.name);
      setSessionCookie(sessionCookie.value);
    }
  }

  return _client;
}

// ---------------------------------------------------------------------------
// MCP server setup: the tools live in mcp-server.ts
// ---------------------------------------------------------------------------

const server = createOlcliMcpServer({ getClient });

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't pollute the MCP stdio channel
  process.stderr.write('olcli MCP server started (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
