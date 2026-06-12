/**
 * Overleaf API Client
 *
 * Provides programmatic access to Overleaf's REST APIs for project
 * management, file operations, and LaTeX compilation.
 */

import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as https from 'node:https';
import * as http from 'node:http';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const USER_AGENT = `olcli/${pkg.version}`;

const DEFAULT_BASE_URL = 'https://www.overleaf.com';

export interface Project {
  id: string;
  name: string;
  lastUpdated: string;
  lastUpdatedBy?: string;
  owner?: { email: string; firstName?: string; lastName?: string };
  archived?: boolean;
  trashed?: boolean;
}

export interface ProjectInfo {
  _id: string;
  name: string;
  rootDoc_id?: string;
  rootFolder: FolderEntry[];
}

export interface FolderEntry {
  _id: string;
  name: string;
  folders: FolderEntry[];
  docs: DocEntry[];
  fileRefs: FileEntry[];
}

export interface DocEntry {
  _id: string;
  name: string;
}

export interface FileEntry {
  _id: string;
  name: string;
}

export interface CommentMessage {
  id: string;
  content: string;
  timestamp?: string | number;
  user_id?: string;
  user?: { email?: string; first_name?: string; last_name?: string; name?: string };
  edited_at?: string | number;
}

export interface ProjectComment {
  threadId: string;
  docId: string;
  path: string;
  position: number;
  line: number;
  column: number;
  selectedText: string;
  resolved: boolean;
  messages: CommentMessage[];
  context?: CommentContext;
}

export interface CommentContext {
  startLine: number;
  endLine: number;
  before: string[];
  line: string;
  after: string[];
}

export type CommentStatus = 'all' | 'open' | 'resolved';

export interface ListCommentsOptions {
  status?: CommentStatus;
  contextLines?: number;
}

export interface AddCommentOptions {
  filePath: string;
  content: string;
  selectedText?: string;
  position?: number;
  line?: number;
  column?: number;
  length?: number;
  occurrence?: number;
}

export interface Credentials {
  cookies: Record<string, string>;
  csrf: string;
  baseUrl?: string;
}

interface ProjectDoc {
  id: string;
  path: string;
}

interface JoinedDocument {
  docId: string;
  lines: string[];
  content: string;
  version: number;
  ranges: any;
  type: 'sharejs-text-ot' | 'history-ot';
}

interface ProjectSocketSession {
  sid: string;
  projectId: string;
  pollUrl: () => string;
}

export class OverleafClient {
  private cookies: Record<string, string>;
  private csrf: string;
  private baseUrl: string;
  private verbose: boolean = false;
  // Cache per-project folder trees so repeated uploads in sync/upload calls
  // don't re-fetch the tree via Socket.IO on every file.
  private folderTreeCache: Map<string, Record<string, string>> = new Map();

  constructor(credentials: Credentials) {
    this.cookies = credentials.cookies;
    this.csrf = credentials.csrf;
    this.baseUrl = credentials.baseUrl || DEFAULT_BASE_URL;
  }

  /** Enable or disable verbose request/response logging to stderr. */
  setVerbose(v: boolean): void {
    this.verbose = v;
  }

  /**
   * Resolve (and cache) the folder tree for a project. Falls back to a
   * minimal tree containing only the root folder when the Socket.IO probe
   * fails (e.g. self-hosted Overleaf without that endpoint).
   */
  async getOrLoadFolderTree(projectId: string): Promise<Record<string, string>> {
    const cached = this.folderTreeCache.get(projectId);
    if (cached) return cached;
    let tree = await this.getFolderTreeFromSocket(projectId);
    if (!tree) {
      const rootId = await this.getRootFolderId(projectId);
      tree = { '': rootId };
    }
    this.folderTreeCache.set(projectId, tree);
    return tree;
  }

  /** Drop the cached folder tree for a project (e.g. after rename/delete). */
  invalidateFolderTree(projectId: string): void {
    this.folderTreeCache.delete(projectId);
  }

  private projectUrl(): string {
    return `${this.baseUrl}/project`;
  }

  private downloadUrl(projectId: string): string {
    return `${this.baseUrl}/project/${projectId}/download/zip`;
  }

  private uploadUrl(projectId: string): string {
    return `${this.baseUrl}/project/${projectId}/upload`;
  }

  private folderUrl(projectId: string): string {
    return `${this.baseUrl}/project/${projectId}/folder`;
  }

  private deleteUrl(projectId: string, entityType: string, entityId: string): string {
    return `${this.baseUrl}/project/${projectId}/${entityType}/${entityId}`;
  }

  private compileUrl(projectId: string): string {
    return `${this.baseUrl}/project/${projectId}/compile?enable_pdf_caching=true`;
  }

  /**
   * Create client from session cookie string
   */
  static async fromSessionCookie(
    sessionCookie: string,
    baseUrl: string = DEFAULT_BASE_URL,
    cookieName: string = 'overleaf_session2'
  ): Promise<OverleafClient> {
    const cookies: Record<string, string> = {
      [cookieName]: sessionCookie
    };

    // Fetch CSRF token from project page
    const initialHeaders: Record<string, string> = {
      'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      'User-Agent': USER_AGENT
    };
    const bootstrapClient = new OverleafClient({ cookies, csrf: 'bootstrap', baseUrl });
    const response = await bootstrapClient.httpRequest(`${baseUrl}/project`, {
      headers: initialHeaders,
      expect: 'text'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch projects page: ${response.status}`);
    }

    bootstrapClient.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    const html = response.body as string;
    const $ = cheerio.load(html);

    // Try multiple methods to find CSRF token (based on PR #66, #82)
    let csrf: string | undefined;

    // Method 1: ol-csrfToken meta tag
    csrf = $('meta[name="ol-csrfToken"]').attr('content');

    // Method 2: hidden input field
    if (!csrf) {
      csrf = $('input[name="_csrf"]').attr('value');
    }

    // Method 3: Look in script tags for csrfToken
    if (!csrf) {
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        const match = content.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/);
        if (match) {
          csrf = match[1];
          break;
        }
      }
    }

    if (!csrf) {
      throw new Error('Could not find CSRF token. Session may have expired.');
    }

    // Update cookies if the bootstrap request added anything
    const updatedCookies = bootstrapClient.cookies;
    return new OverleafClient({ cookies: updatedCookies, csrf, baseUrl });
  }

  private getCookieHeader(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private getHeaders(includeContentType = false): Record<string, string> {
    const headers: Record<string, string> = {
      'Cookie': this.getCookieHeader(),
      'User-Agent': USER_AGENT,
      'X-Csrf-Token': this.csrf
    };
    if (includeContentType) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    if (!headers) return normalized;
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        normalized[key] = value;
      }
    }
    return normalized;
  }

  private applySetCookieHeaders(setCookie: string[] | undefined): void {
    if (!setCookie) return;
    for (const setCookieHeader of setCookie) {
      const match = setCookieHeader.match(/^([^=]+)=([^;]+)/);
      if (match) {
        this.cookies[match[1]] = match[2];
      }
    }
  }

  private logVerbose(...args: any[]): void {
    if (this.verbose) {
      // eslint-disable-next-line no-console
      console.error('[olcli]', ...args);
    }
  }

  private async httpRequest(url: string, options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | FormData;
    timeoutMs?: number;
    maxRedirects?: number;
    expect?: 'text' | 'json' | 'buffer';
  } = {}): Promise<{ status: number; ok: boolean; headers: Record<string, string | string[]>; body: string | Buffer | any }> {
    const method = options.method || 'GET';
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxRedirects = options.maxRedirects ?? 5;
    const expect = options.expect ?? 'text';

    // Normalize FormData bodies into a multipart Buffer + headers using Node's
    // built-in Web Fetch primitives. Keeps every code path on httpRequest
    // (no fetch() reintroduction) while properly serializing multipart uploads.
    let bodyBuffer: string | Buffer | undefined;
    let extraHeaders: Record<string, string> = {};
    if (options.body instanceof FormData) {
      const req = new Request('http://x/', { method: 'POST', body: options.body });
      const arrayBuf = await req.arrayBuffer();
      bodyBuffer = Buffer.from(arrayBuf);
      const ct = req.headers.get('content-type');
      if (ct) extraHeaders['Content-Type'] = ct;
      extraHeaders['Content-Length'] = String(bodyBuffer.length);
    } else if (options.body !== undefined) {
      bodyBuffer = options.body as string | Buffer;
    }

    const doRequest = (reqUrl: string, redirectsLeft: number): Promise<{ status: number; ok: boolean; headers: Record<string, string | string[]>; body: string | Buffer | any }> => {
      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(reqUrl);
        const transport = parsedUrl.protocol === 'https:' ? https : http;
        const headers = this.normalizeHeaders({ ...extraHeaders, ...options.headers });

        const req = transport.request(reqUrl, { method, headers }, (res) => {
          const status = res.statusCode || 0;
          const resHeaders = res.headers as Record<string, string | string[]>;

          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            this.logVerbose(`${method} ${reqUrl} -> ${status} redirect -> ${res.headers.location}`);
            const redirectUrl = new URL(res.headers.location, reqUrl).toString();
            res.resume();
            doRequest(redirectUrl, redirectsLeft - 1).then(resolve, reject);
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            let body: any = buffer;
            if (expect === 'text') {
              body = buffer.toString('utf-8');
            } else if (expect === 'json') {
              try {
                body = JSON.parse(buffer.toString('utf-8'));
              } catch (e) {
                this.logVerbose(`${method} ${reqUrl} -> ${status} (invalid JSON, ${buffer.length} bytes)`);
                return reject(new Error(`Failed to parse JSON response from ${reqUrl}`));
              }
            }
            const ok = status >= 200 && status < 300;
            if (this.verbose) {
              const ct = (resHeaders['content-type'] || '') as string;
              let snippet = '';
              if (!ok) {
                const text = expect === 'buffer' ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
                snippet = text ? ` body=${text.slice(0, 200).replace(/\s+/g, ' ')}` : '';
              }
              this.logVerbose(`${method} ${reqUrl} -> ${status} (${buffer.length}B ${ct})${snippet}`);
            }
            resolve({ status, ok, headers: resHeaders, body });
          });
          res.on('error', reject);
        });

        req.on('error', reject);

        if (timeoutMs) {
          req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
          });
        }

        if (bodyBuffer !== undefined) {
          req.write(bodyBuffer);
        }

        req.end();
      });
    };

    return doRequest(url, maxRedirects);
  }

  /**
   * Get all projects (not archived, not trashed)
   */
  async listProjects(): Promise<Project[]> {
    const response = await this.httpRequest(this.projectUrl(), {
      headers: this.getHeaders(),
      expect: 'text'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch projects: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    const html = response.body as string;
    const $ = cheerio.load(html);

    // Try new Overleaf structure first (PR #82)
    let projectsData: any[] = [];

    // Method 1: ol-prefetchedProjectsBlob (newest Overleaf)
    const prefetchedBlob = $('meta[name="ol-prefetchedProjectsBlob"]').attr('content');
    if (prefetchedBlob) {
      try {
        const data = JSON.parse(prefetchedBlob);
        projectsData = data.projects || data;
      } catch (e) {
        // Try next method
      }
    }

    // Method 2: Meta tag with projects content (PR #73)
    if (projectsData.length === 0) {
      const metas = $('meta[content]').toArray();
      for (const meta of metas) {
        const content = $(meta).attr('content') || '';
        if (content.includes('"projects"')) {
          try {
            const data = JSON.parse(content);
            if (data.projects) {
              projectsData = data.projects;
              break;
            }
          } catch (e) {
            // Continue
          }
        }
      }
    }

    // Method 3: ol-projects meta tag (legacy)
    if (projectsData.length === 0) {
      const projectsMeta = $('meta[name="ol-projects"]').attr('content');
      if (projectsMeta) {
        try {
          projectsData = JSON.parse(projectsMeta);
        } catch (e) {
          // Continue
        }
      }
    }

    // Filter out archived and trashed
    return projectsData
      .filter((p: any) => !p.archived && !p.trashed)
      .map((p: any) => ({
        id: p.id || p._id,
        name: p.name,
        lastUpdated: p.lastUpdated,
        lastUpdatedBy: p.lastUpdatedBy,
        owner: p.owner,
        archived: p.archived,
        trashed: p.trashed
      }));
  }

  /**
   * Get project by name
   */
  async getProject(name: string): Promise<Project | undefined> {
    const projects = await this.listProjects();
    return projects.find(p => p.name === name);
  }

  /**
   * Get project by ID
   */
  async getProjectById(id: string): Promise<Project | undefined> {
    const projects = await this.listProjects();
    return projects.find(p => p.id === id);
  }

  /**
   * Get detailed project info including file tree
   */
  async getProjectInfo(projectId: string): Promise<ProjectInfo> {
    const response = await this.httpRequest(`${this.projectUrl()}/${projectId}`, {
      headers: this.getHeaders(),
      expect: 'text'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch project info: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    const html = response.body as string;
    const $ = cheerio.load(html);

    // Look for project data in meta tags
    let projectInfo: ProjectInfo | undefined;

    // Try ol-project meta tag
    const projectMeta = $('meta[name="ol-project"]').attr('content');
    if (projectMeta) {
      try {
        projectInfo = JSON.parse(projectMeta);
      } catch (e) {
        // Continue
      }
    }

    // Try to find in other meta tags
    if (!projectInfo) {
      const metas = $('meta[content]').toArray();
      for (const meta of metas) {
        const content = $(meta).attr('content') || '';
        if (content.includes('rootFolder')) {
          try {
            projectInfo = JSON.parse(content);
            break;
          } catch (e) {
            // Continue
          }
        }
      }
    }

    // Fallback: Overleaf no longer ships the project tree in meta tags.
    // Use the Socket.IO joinProjectResponse payload (same source used for
    // root folder discovery) to retrieve the full project info.
    if (!projectInfo) {
      const socketProject = await this.getProjectFromSocket(projectId);
      if (socketProject) {
        projectInfo = socketProject as ProjectInfo;
      }
    }

    if (!projectInfo) {
      throw new Error('Could not parse project info');
    }

    return projectInfo;
  }

  /**
   * Fetch the full project object via the collaboration socket.
   * Returns the `project` field of the joinProjectResponse, which contains
   * the rootFolder tree and other metadata that used to live in ol-project.
   */
  private async getProjectFromSocket(projectId: string): Promise<any | null> {
    let sid: string | null = null;
    try {
      const handshakeUrl = `${this.baseUrl}/socket.io/1/?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
      const handshakeResponse = await this.httpRequest(handshakeUrl, {
        headers: { 'Cookie': this.getCookieHeader(), 'User-Agent': USER_AGENT },
        expect: 'text',
        timeoutMs: 5000
      });
      if (!handshakeResponse.ok) return null;
      this.applySetCookieHeaders(handshakeResponse.headers['set-cookie'] as string[] | undefined);
      const handshakeBody = (handshakeResponse.body as string).trim();
      sid = handshakeBody.split(':')[0];
      if (!sid) return null;

      const buildPollUrl = () =>
        `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;

      for (let attempt = 0; attempt < 6; attempt++) {
        const pollResponse = await this.httpRequest(buildPollUrl(), {
          headers: { 'Cookie': this.getCookieHeader(), 'User-Agent': USER_AGENT },
          expect: 'text',
          timeoutMs: 5000
        });
        if (!pollResponse.ok) return null;
        this.applySetCookieHeaders(pollResponse.headers['set-cookie'] as string[] | undefined);
        const packets = this.decodeSocketIoPayload(pollResponse.body as string);
        for (const packet of packets) {
          if (packet.startsWith('5:::')) {
            try {
              const payload = JSON.parse(packet.slice(4));
              if (payload?.name === 'joinProjectResponse' && payload?.args?.[0]?.project) {
                return payload.args[0].project;
              }
            } catch { /* ignore */ }
          }
          if (packet.startsWith('2::')) {
            const heartbeatResponse = await this.httpRequest(buildPollUrl(), {
              method: 'POST',
              headers: {
                'Cookie': this.getCookieHeader(),
                'User-Agent': USER_AGENT,
                'Content-Type': 'text/plain;charset=UTF-8'
              },
              body: '2::',
              expect: 'text',
              timeoutMs: 5000
            });
            this.applySetCookieHeaders(heartbeatResponse.headers['set-cookie'] as string[] | undefined);
          }
        }
      }
    } catch {
      // fall through
    } finally {
      if (sid) {
        try {
          const disconnectUrl = `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
          const disconnectResponse = await this.httpRequest(disconnectUrl, {
            method: 'POST',
            headers: {
              'Cookie': this.getCookieHeader(),
              'User-Agent': USER_AGENT,
              'Content-Type': 'text/plain;charset=UTF-8'
            },
            body: '0::',
            expect: 'text',
            timeoutMs: 5000
          });
          this.applySetCookieHeaders(disconnectResponse.headers['set-cookie'] as string[] | undefined);
        } catch { /* ignore */ }
      }
    }
    return null;
  }

  /**
   * Download a URL as a Buffer using Node.js http/https modules.
   *
   * This avoids fetch's strict header validation which rejects non-Latin1
   * characters in response headers (e.g. Content-Disposition with Unicode
   * project names). See: https://github.com/aloth/olcli/issues/2
   */
  private async downloadBuffer(url: string): Promise<Buffer> {
    const response = await this.httpRequest(url, {
      headers: this.getHeaders(),
      expect: 'buffer'
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    return response.body as Buffer;
  }

  /**
   * Download project as zip
   *
   * Uses downloadBuffer to avoid ByteString errors from non-Latin1
   * Content-Disposition headers. See: https://github.com/aloth/olcli/issues/2
   */
  async downloadProject(projectId: string): Promise<Buffer> {
    return this.downloadBuffer(this.downloadUrl(projectId));
  }

  /**
   * Compile project and get PDF
   */
  async compileProject(projectId: string): Promise<{ pdfUrl: string; logs: string[] }> {
    const response = await this.httpRequest(this.compileUrl(projectId), {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({
        rootDoc_id: null,
        draft: false,
        check: 'silent',
        incrementalCompilesEnabled: true
      }),
      expect: 'json'
    });

    if (!response.ok) {
      throw new Error(`Failed to compile project: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    const data = response.body as any;

    if (data.status !== 'success') {
      throw new Error(`Compilation failed: ${data.status}`);
    }

    // Match by path 'output.pdf' — Overleaf's CLSI always names the main
    // compile output 'output.pdf'. Matching only on type === 'pdf' can pick up
    // figure PDFs or *-eps-converted-to.pdf intermediates. See #26.
    const pdfFile = data.outputFiles?.find((f: any) => f.path === 'output.pdf')
      || data.outputFiles?.find((f: any) => f.type === 'pdf');
    if (!pdfFile) {
      throw new Error('No PDF output found');
    }

    // Overleaf's CDN requires ?clsiserverid=<id> for build-output downloads.
    // Without it the build URL 404s. See: https://github.com/aloth/olcli/issues/22
    const qs = data.clsiServerId ? `?clsiserverid=${encodeURIComponent(data.clsiServerId)}` : '';
    return {
      pdfUrl: `${this.baseUrl}${pdfFile.url}${qs}`,
      logs: data.compileGroup ? [`Compile group: ${data.compileGroup}`] : []
    };
  }

  /**
   * Download compiled PDF
   */
  async downloadPdf(projectId: string): Promise<Buffer> {
    const { pdfUrl } = await this.compileProject(projectId);
    return this.downloadBuffer(pdfUrl);
  }

  /**
   * Create a folder in a project
   */
  async createFolder(projectId: string, parentFolderId: string, name: string): Promise<string> {
    const response = await this.httpRequest(this.folderUrl(projectId), {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({
        parent_folder_id: parentFolderId,
        name
      }),
      expect: 'json'
    });

    if (response.status === 400) {
      // Folder already exists
      throw new Error('Folder already exists');
    }

    if (!response.ok) {
      throw new Error(`Failed to create folder: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    const data = response.body as any;
    return data._id;
  }

  /**
   * Compute root folder ID from project ID
   * MongoDB ObjectIDs are 24 hex chars. The root folder ID is typically projectId - 1
   */
  computeRootFolderId(projectId: string): string {
    // Parse the last 8 chars as a hex number (the counter portion)
    const prefix = projectId.slice(0, 16);
    const suffix = projectId.slice(16);
    const counter = parseInt(suffix, 16);
    const newCounter = (counter - 1).toString(16).padStart(8, '0');
    return prefix + newCounter;
  }

  /**
   * Decode Socket.IO 0.9 payloads. Frames may be a single packet or \ufffd-length framed packets.
   */
  private decodeSocketIoPayload(payload: string): string[] {
    if (!payload) return [];
    if (!payload.startsWith('\ufffd')) return [payload];

    const packets: string[] = [];
    let i = 0;

    while (i < payload.length) {
      if (payload[i] !== '\ufffd') break;
      i += 1;

      let len = '';
      while (i < payload.length && payload[i] !== '\ufffd') {
        len += payload[i];
        i += 1;
      }

      if (i >= payload.length || payload[i] !== '\ufffd') break;
      i += 1;

      const packetLen = Number.parseInt(len, 10);
      if (!Number.isFinite(packetLen) || packetLen < 0) break;

      packets.push(payload.slice(i, i + packetLen));
      i += packetLen;
    }

    return packets;
  }

  private encodeSocketIoEvent(id: number, name: string, args: any[]): string {
    return `5:${id}+::${JSON.stringify({ name, args })}`;
  }

  private parseSocketIoAck(packet: string, id: number): any[] | null {
    const match = packet.match(/^6:::(\d+)(.*)$/);
    if (!match || Number.parseInt(match[1], 10) !== id) {
      return null;
    }

    let payload = match[2] || '';
    if (payload.startsWith('+')) {
      payload = payload.slice(1);
    }
    if (!payload) return [];

    const args = JSON.parse(payload);
    return Array.isArray(args) ? args : [args];
  }

  private decodeOverleafUtf8(text: string): string {
    return Buffer.from(text, 'binary').toString('utf-8');
  }

  private generateCommentThreadId(): string {
    const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    const machine = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    const pid = Math.floor(Math.random() * 0x7fff).toString(16).padStart(4, '0');
    return `${timestamp}${machine}${pid}000001`;
  }

  private positionToLineColumn(content: string, position: number): { line: number; column: number } {
    const prefix = content.slice(0, position);
    const lines = prefix.split('\n');
    return {
      line: lines.length,
      column: lines[lines.length - 1].length + 1
    };
  }

  private buildCommentContext(content: string, line: number, contextLines = 0): CommentContext | undefined {
    if (contextLines <= 0) return undefined;

    const lines = content.split('\n');
    const lineIndex = line - 1;
    const beforeStart = Math.max(0, lineIndex - contextLines);
    const afterEnd = Math.min(lines.length, lineIndex + contextLines + 1);

    return {
      startLine: beforeStart + 1,
      endLine: afterEnd,
      before: lines.slice(beforeStart, lineIndex),
      line: lines[lineIndex] || '',
      after: lines.slice(lineIndex + 1, afterEnd)
    };
  }

  private collectProjectDocs(projectInfo: ProjectInfo): ProjectDoc[] {
    const docs: ProjectDoc[] = [];

    function walk(folder: FolderEntry, folderPath: string): void {
      for (const doc of folder.docs || []) {
        docs.push({
          id: doc._id,
          path: folderPath ? `${folderPath}/${doc.name}` : doc.name
        });
      }
      for (const child of folder.folders || []) {
        const childPath = folderPath ? `${folderPath}/${child.name}` : child.name;
        walk(child, childPath);
      }
    }

    for (const folder of projectInfo.rootFolder || []) {
      walk(folder, '');
    }

    return docs;
  }

  private async openProjectSocket(projectId: string): Promise<ProjectSocketSession> {
    const handshakeUrl = `${this.baseUrl}/socket.io/1/?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
    const handshakeResponse = await this.httpRequest(handshakeUrl, {
      headers: { 'Cookie': this.getCookieHeader(), 'User-Agent': USER_AGENT },
      expect: 'text',
      timeoutMs: 5000
    });

    if (!handshakeResponse.ok) {
      throw new Error(`Failed to open project socket: ${handshakeResponse.status}`);
    }

    this.applySetCookieHeaders(handshakeResponse.headers['set-cookie'] as string[] | undefined);
    const sid = (handshakeResponse.body as string).trim().split(':')[0];
    if (!sid) {
      throw new Error('Failed to open project socket: missing session id');
    }

    const session: ProjectSocketSession = {
      sid,
      projectId,
      pollUrl: () => `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`
    };

    for (let attempt = 0; attempt < 8; attempt++) {
      const packets = await this.pollProjectSocket(session);
      if (packets.some(packet => {
        if (!packet.startsWith('5:::')) return false;
        try {
          return JSON.parse(packet.slice(4))?.name === 'joinProjectResponse';
        } catch {
          return false;
        }
      })) {
        return session;
      }
    }

    throw new Error('Project socket did not return joinProjectResponse');
  }

  private async pollProjectSocket(session: ProjectSocketSession): Promise<string[]> {
    const response = await this.httpRequest(session.pollUrl(), {
      headers: { 'Cookie': this.getCookieHeader(), 'User-Agent': USER_AGENT },
      expect: 'text',
      timeoutMs: 7000
    });

    if (!response.ok) {
      throw new Error(`Socket poll failed: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
    const packets = this.decodeSocketIoPayload(response.body as string);

    for (const packet of packets) {
      if (packet.startsWith('2::')) {
        const heartbeatResponse = await this.httpRequest(session.pollUrl(), {
          method: 'POST',
          headers: {
            'Cookie': this.getCookieHeader(),
            'User-Agent': USER_AGENT,
            'Content-Type': 'text/plain;charset=UTF-8'
          },
          body: '2::',
          expect: 'text',
          timeoutMs: 5000
        });
        this.applySetCookieHeaders(heartbeatResponse.headers['set-cookie'] as string[] | undefined);
      }
    }

    return packets;
  }

  private async postProjectSocketPacket(session: ProjectSocketSession, packet: string): Promise<void> {
    const response = await this.httpRequest(session.pollUrl(), {
      method: 'POST',
      headers: {
        'Cookie': this.getCookieHeader(),
        'User-Agent': USER_AGENT,
        'Content-Type': 'text/plain;charset=UTF-8'
      },
      body: packet,
      expect: 'text',
      timeoutMs: 5000
    });

    if (!response.ok) {
      throw new Error(`Socket post failed: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
  }

  private async socketRpc(session: ProjectSocketSession, name: string, args: any[]): Promise<any[]> {
    const id = Math.floor(Math.random() * 0x7fffffff);
    await this.postProjectSocketPacket(session, this.encodeSocketIoEvent(id, name, args));

    for (let attempt = 0; attempt < 10; attempt++) {
      const packets = await this.pollProjectSocket(session);
      for (const packet of packets) {
        const ackArgs = this.parseSocketIoAck(packet, id);
        if (ackArgs) {
          const [error, ...result] = ackArgs;
          if (error) {
            const message = typeof error === 'string' ? error : error.message || JSON.stringify(error);
            throw new Error(`${name} failed: ${message}`);
          }
          return result;
        }
      }
    }

    throw new Error(`${name} did not return an acknowledgement`);
  }

  private async closeProjectSocket(session: ProjectSocketSession): Promise<void> {
    try {
      await this.postProjectSocketPacket(session, '0::');
    } catch {
      // Best-effort socket cleanup only.
    }
  }

  private normalizeJoinedDocument(docId: string, args: any[]): JoinedDocument {
    const [lines, version, _updates, ranges, type = 'sharejs-text-ot'] = args;

    if (type === 'history-ot') {
      const content = typeof lines?.content === 'string' ? lines.content : '';
      return {
        docId,
        lines: content.split('\n'),
        content,
        version,
        ranges: lines,
        type
      };
    }

    const decodedLines = Array.isArray(lines)
      ? lines.map((line: string) => this.decodeOverleafUtf8(line))
      : [];
    const decodedRanges = ranges || {};
    for (const comment of decodedRanges.comments || []) {
      if (comment?.op?.c) {
        comment.op.c = this.decodeOverleafUtf8(comment.op.c);
      }
    }

    return {
      docId,
      lines: decodedLines,
      content: decodedLines.join('\n'),
      version,
      ranges: decodedRanges,
      type
    };
  }

  private async joinDocument(session: ProjectSocketSession, docId: string): Promise<JoinedDocument> {
    const args = await this.socketRpc(session, 'joinDoc', [
      docId,
      {
        encodeRanges: true,
        supportsHistoryOT: true
      }
    ]);

    return this.normalizeJoinedDocument(docId, args);
  }

  /**
   * Extract root folder ID from a Socket.IO event packet (joinProjectResponse).
   */
  private extractRootFolderIdFromSocketPacket(packet: string): string | null {
    if (!packet.startsWith('5:::')) return null;

    try {
      const payload = JSON.parse(packet.slice(4));
      if (payload?.name !== 'joinProjectResponse') return null;

      const rootFolderId = payload?.args?.[0]?.project?.rootFolder?.[0]?._id;
      return typeof rootFolderId === 'string' ? rootFolderId : null;
    } catch {
      return null;
    }
  }

  /**
   * Extract full folder tree from a Socket.IO joinProjectResponse packet.
   * Returns a map of folder path -> folder ID, e.g. { '': rootId, 'figures': figuresId }
   */
  private extractFolderTreeFromSocketPacket(packet: string): Record<string, string> | null {
    if (!packet.startsWith('5:::')) return null;

    try {
      const payload = JSON.parse(packet.slice(4));
      if (payload?.name !== 'joinProjectResponse') return null;

      const rootFolder = payload?.args?.[0]?.project?.rootFolder?.[0];
      if (!rootFolder?._id) return null;

      const folderMap: Record<string, string> = {};

      function walkFolders(folder: any, currentPath: string): void {
        folderMap[currentPath] = folder._id;
        for (const sub of folder.folders || []) {
          const subPath = currentPath ? `${currentPath}/${sub.name}` : sub.name;
          walkFolders(sub, subPath);
        }
      }

      walkFolders(rootFolder, '');
      return folderMap;
    } catch {
      return null;
    }
  }

  /**
   * main problem to resolve root folder ID from Overleaf's collaboration join payload
   * authoritative for projects where ObjectID arithmetic does not apply
   */
  private async getRootFolderIdFromSocket(projectId: string): Promise<string | null> {
    let sid: string | null = null;

    try {
      const handshakeUrl = `${this.baseUrl}/socket.io/1/?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
      const handshakeResponse = await this.httpRequest(handshakeUrl, {
        headers: {
          'Cookie': this.getCookieHeader(),
          'User-Agent': USER_AGENT
        },
        expect: 'text',
        timeoutMs: 5000
      });

      if (!handshakeResponse.ok) return null;
      this.applySetCookieHeaders(handshakeResponse.headers['set-cookie'] as string[] | undefined);

      const handshakeBody = (handshakeResponse.body as string).trim();
      sid = handshakeBody.split(':')[0];
      if (!sid) return null;

      const buildPollUrl = () =>
        `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;

      let discoveredRootFolderId: string | null = null;

      // poll a few frames, first is usually connect ack, next includes joinProjectResponse
      for (let attempt = 0; attempt < 3; attempt++) {
        const pollResponse = await this.httpRequest(buildPollUrl(), {
          headers: {
            'Cookie': this.getCookieHeader(),
            'User-Agent': USER_AGENT
          },
          expect: 'text',
          timeoutMs: 5000
        });

        if (!pollResponse.ok) return null;
        this.applySetCookieHeaders(pollResponse.headers['set-cookie'] as string[] | undefined);

        const payload = pollResponse.body as string;
        const packets = this.decodeSocketIoPayload(payload);

        for (const packet of packets) {
          const rootFolderId = this.extractRootFolderIdFromSocketPacket(packet);
          if (rootFolderId) {
            discoveredRootFolderId = rootFolderId;
            break;
          }

          if (packet.startsWith('2::')) {
            //reply to heartbeat to keep polling transport alive
            const heartbeatResponse = await this.httpRequest(buildPollUrl(), {
              method: 'POST',
              headers: {
                'Cookie': this.getCookieHeader(),
                'User-Agent': USER_AGENT,
                'Content-Type': 'text/plain;charset=UTF-8'
              },
              body: '2::',
              expect: 'text',
              timeoutMs: 5000
            });
            this.applySetCookieHeaders(heartbeatResponse.headers['set-cookie'] as string[] | undefined);
          }
        }

        if (discoveredRootFolderId) {
          return discoveredRootFolderId;
        }
      }
    } catch {
      // Fall back to non-socket methods.
    } finally {
      if (sid) {
        try {
          const disconnectUrl =
            `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
          const disconnectResponse = await this.httpRequest(disconnectUrl, {
            method: 'POST',
            headers: {
              'Cookie': this.getCookieHeader(),
              'User-Agent': USER_AGENT,
              'Content-Type': 'text/plain;charset=UTF-8'
            },
            body: '0::',
            expect: 'text',
            timeoutMs: 5000
          });
          this.applySetCookieHeaders(disconnectResponse.headers['set-cookie'] as string[] | undefined);
        } catch {
          // Ignore cleanup failures.
        }
      }
    }

    return null;
  }

  /**
   * Get full folder tree for a project via Socket.IO.
   * Returns a map of folder path -> folder ID, e.g. { '': rootId, 'figures': figuresId }
   */
  async getFolderTreeFromSocket(projectId: string): Promise<Record<string, string> | null> {
    let sid: string | null = null;

    try {
      const handshakeUrl = `${this.baseUrl}/socket.io/1/?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
      const handshakeResponse = await this.httpRequest(handshakeUrl, {
        headers: {
          'Cookie': this.getCookieHeader(),
          'User-Agent': USER_AGENT
        },
        expect: 'text',
        timeoutMs: 5000
      });

      if (!handshakeResponse.ok) return null;
      this.applySetCookieHeaders(handshakeResponse.headers['set-cookie'] as string[] | undefined);

      const handshakeBody = (handshakeResponse.body as string).trim();
      sid = handshakeBody.split(':')[0];
      if (!sid) return null;

      const buildPollUrl = () =>
        `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;

      for (let attempt = 0; attempt < 3; attempt++) {
        const pollResponse = await this.httpRequest(buildPollUrl(), {
          headers: {
            'Cookie': this.getCookieHeader(),
            'User-Agent': USER_AGENT
          },
          expect: 'text',
          timeoutMs: 5000
        });

        if (!pollResponse.ok) return null;
        this.applySetCookieHeaders(pollResponse.headers['set-cookie'] as string[] | undefined);

        const payload = pollResponse.body as string;
        const packets = this.decodeSocketIoPayload(payload);

        for (const packet of packets) {
          const folderTree = this.extractFolderTreeFromSocketPacket(packet);
          if (folderTree) return folderTree;

          if (packet.startsWith('2::')) {
            const heartbeatResponse = await this.httpRequest(buildPollUrl(), {
              method: 'POST',
              headers: {
                'Cookie': this.getCookieHeader(),
                'User-Agent': USER_AGENT,
                'Content-Type': 'text/plain;charset=UTF-8'
              },
              body: '2::',
              expect: 'text',
              timeoutMs: 5000
            });
            this.applySetCookieHeaders(heartbeatResponse.headers['set-cookie'] as string[] | undefined);
          }
        }
      }
    } catch {
      // Fall back
    } finally {
      if (sid) {
        try {
          const disconnectUrl =
            `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
          await this.httpRequest(disconnectUrl, {
            method: 'POST',
            headers: {
              'Cookie': this.getCookieHeader(),
              'User-Agent': USER_AGENT,
              'Content-Type': 'text/plain;charset=UTF-8'
            },
            body: '0::',
            expect: 'text',
            timeoutMs: 5000
          });
        } catch {
          // Ignore cleanup failures.
        }
      }
    }

    return null;
  }

  /**
   * Resolve a folder path to a folder ID, creating missing folders as needed.
   * folderTree is a map of path -> ID (fetched once per push session).
   * folderPath is e.g. 'figures' or 'a/b/c'.
   */
  async resolveFolderId(
    projectId: string,
    folderTree: Record<string, string>,
    folderPath: string
  ): Promise<string> {
    if (!folderPath || folderPath === '') return folderTree[''];
    if (folderTree[folderPath]) return folderTree[folderPath];

    // Create each missing segment
    const segments = folderPath.split('/');
    let currentPath = '';

    for (const segment of segments) {
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      if (folderTree[currentPath]) continue;

      const parentId = folderTree[parentPath];
      if (!parentId) throw new Error(`Cannot resolve parent folder for: ${currentPath}`);

      try {
        const newId = await this.createFolder(projectId, parentId, segment);
        folderTree[currentPath] = newId;
      } catch (e: any) {
        if (e.message === 'Folder already exists') {
          // Folder exists but we don't have its ID - re-fetch tree
          const freshTree = await this.getFolderTreeFromSocket(projectId);
          if (freshTree?.[currentPath]) {
            folderTree[currentPath] = freshTree[currentPath];
          } else {
            throw new Error(`Folder '${currentPath}' exists but could not resolve its ID`);
          }
        } else {
          throw e;
        }
      }
    }

    return folderTree[folderPath];
  }

  /**
   * Get root folder ID for a project (tries multiple methods)
   */
  async getRootFolderId(projectId: string): Promise<string> {
    // Method 1: Try to get from project page meta tags
    try {
      const projectInfo = await this.getProjectInfo(projectId);
      if (projectInfo.rootFolder?.[0]?._id) {
        return projectInfo.rootFolder[0]._id;
      }
    } catch (e) {
      // Fall through to computed method
    }

    // Method 2: Ask collaboration socket (authoritative project tree)
    const socketRootFolderId = await this.getRootFolderIdFromSocket(projectId);
    if (socketRootFolderId) {
      return socketRootFolderId;
    }

    // Method 3: Compute from project ID (projectId - 1)
    return this.computeRootFolderId(projectId);
  }

  /**
   * Find root folder ID by probing multiple candidates
   * This handles cases where projectId - 1 doesn't work
   */
  async probeRootFolderId(projectId: string): Promise<string | null> {
    const candidates: string[] = [];
    
    // Method 1: Try projectId - 1 (most common)
    candidates.push(this.computeRootFolderId(projectId));
    
    const prefix = projectId.slice(0, 16);
    const suffix = parseInt(projectId.slice(16), 16);
    
    // Method 2: Try a wide range around the project ID
    // Some projects have root folder created with different offsets
    for (let i = 2; i <= 50; i++) {
      if (suffix - i >= 0) {
        candidates.push(prefix + (suffix - i).toString(16).padStart(8, '0'));
      }
    }
    for (let i = 1; i <= 50; i++) {
      candidates.push(prefix + (suffix + i).toString(16).padStart(8, '0'));
    }

    // Test each candidate with a minimal probe request
    for (const folderId of candidates) {
      try {
        // Try to create a temp file to probe the folder
        const testFileName = `.olcli-probe-${Date.now()}.tmp`;
        const formData = new FormData();
        formData.append('targetFolderId', folderId);
        formData.append('name', testFileName);
        formData.append('type', 'text/plain');
        formData.append('qqfile', new Blob(['probe']), testFileName);

        const response = await this.httpRequest(`${this.uploadUrl(projectId)}?folder_id=${folderId}`, {
          method: 'POST',
          headers: {
            'Cookie': this.getCookieHeader(),
            'User-Agent': USER_AGENT,
            'X-Csrf-Token': this.csrf
          },
          body: formData as unknown as Buffer,
          expect: 'json'
        });

        if (!response.ok) {
          continue;
        }

        this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

        const data = response.body as any;
        if (data.success !== false && data.entity_id) {
          // Success! Delete the probe file and return this folder ID
          try {
            await this.deleteEntity(projectId, data.entity_id, 'doc');
          } catch (e) {
            // Ignore delete errors for probe file
          }
          return folderId;
        }
      } catch (e) {
        // Continue to next candidate
      }
    }

    return null;
  }

  /**
   * Upload a file to a project.
   * If folderTree is provided and fileName contains a path (e.g. 'figures/img.png'),
   * the file will be uploaded into the correct subfolder, creating it if needed.
   */
  async uploadFile(
    projectId: string,
    folderId: string | null,
    fileName: string,
    content: Buffer,
    folderTree?: Record<string, string>
  ): Promise<{ success: boolean; entityId?: string; entityType?: string }> {
    // Extract just the filename without path
    const baseName = fileName.split('/').pop() || fileName;

    // Resolve target folder: if fileName has a directory part, place the file there.
    // Lazy-load + cache the folder tree when caller didn't supply one, so external
    // callers (and our own `upload`/`sync` paths) don't silently dump files into root.
    // See: https://github.com/aloth/olcli/issues/22 follow-up + 0.3.1 upload-fix.
    const dirPart = fileName.includes('/') ? fileName.split('/').slice(0, -1).join('/') : '';
    let targetFolderId: string;
    if (dirPart) {
      const tree = folderTree || await this.getOrLoadFolderTree(projectId);
      targetFolderId = await this.resolveFolderId(projectId, tree, dirPart);
    } else {
      targetFolderId = folderId || await this.getRootFolderId(projectId);
    }

    // Determine MIME type
    const ext = baseName.split('.').pop()?.toLowerCase() || '';
    const mimeTypes: Record<string, string> = {
      'tex': 'text/x-tex',
      'bib': 'text/x-bibtex',
      'cls': 'text/x-tex',
      'sty': 'text/x-tex',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'pdf': 'application/pdf',
      'svg': 'image/svg+xml',
      'eps': 'application/postscript'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    // Helper function to attempt upload with a specific folder ID
    const tryUpload = async (fid: string): Promise<{ success: boolean; entityId?: string; entityType?: string; error?: string }> => {
      const formData = new FormData();
      formData.append('targetFolderId', fid);
      formData.append('name', baseName);
      formData.append('type', mimeType);
      formData.append('qqfile', new Blob([content]), baseName);

      const response = await this.httpRequest(`${this.uploadUrl(projectId)}?folder_id=${encodeURIComponent(fid)}`, {
        method: 'POST',
        headers: {
          'Cookie': this.getCookieHeader(),
          'User-Agent': USER_AGENT,
          'X-Csrf-Token': this.csrf
        },
        body: formData as unknown as Buffer,
        expect: 'text'
      });

      if (!response.ok) {
        const text = response.body as string;
        // Overleaf returns folder_not_found as HTTP 422 JSON.
        // Parse the body first so caller can trigger folder probing fallback.
        try {
          const data = JSON.parse(text);
          if (data?.error === 'folder_not_found') {
            return { success: false, error: 'folder_not_found' };
          }
        } catch (e) {
          // Ignore non-JSON responses and return generic HTTP error below.
        }
        return { success: false, error: `${response.status} - ${text}` };
      }

      this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

      const data = JSON.parse(response.body as string) as any;
      if (data.success === false && data.error === 'folder_not_found') {
        return { success: false, error: 'folder_not_found' };
      }
      return {
        success: data.success !== false,
        entityId: data.entity_id,
        entityType: data.entity_type
      };
    };

    // First attempt with computed/cached folder ID
    let result = await tryUpload(targetFolderId);

    // If cached folder ID is stale, re-resolve root folder ID and retry once.
    if (!result.success && result.error === 'folder_not_found') {
      const refreshedRootFolderId = await this.getRootFolderId(projectId);
      if (refreshedRootFolderId !== targetFolderId) {
        targetFolderId = refreshedRootFolderId;
        result = await tryUpload(targetFolderId);
      }
    }

    // If folder is still unresolved, probe for a valid root folder ID
    if (!result.success && result.error === 'folder_not_found') {
      const probedFolderId = await this.probeRootFolderId(projectId);
      if (probedFolderId && probedFolderId !== targetFolderId) {
        targetFolderId = probedFolderId;
        result = await tryUpload(targetFolderId);
      }
    }

    if (!result.success) {
      throw new Error(`Failed to upload file: ${result.error || 'unknown error'}`);
    }

    return {
      success: result.success,
      entityId: result.entityId,
      entityType: result.entityType
    };
  }

  /**
   * Delete a file or folder
   */
  async deleteEntity(
    projectId: string,
    entityId: string,
    entityType: 'doc' | 'file' | 'folder'
  ): Promise<void> {
    const url = this.deleteUrl(projectId, entityType, entityId);

    const response = await this.httpRequest(url, {
      method: 'DELETE',
      headers: this.getHeaders(),
      expect: 'text'
    });

    if (!response.ok) {
      throw new Error(`Failed to delete entity: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
  }

  /**
   * Get list of entities (files/docs) with paths
   */
  async getEntities(projectId: string): Promise<{ path: string; type: 'doc' | 'file' }[]> {
    const response = await this.httpRequest(`${this.baseUrl}/project/${projectId}/entities`, {
      headers: this.getHeaders(),
      expect: 'json'
    });

    if (!response.ok) {
      throw new Error(`Failed to get entities: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    const data = response.body as any;
    return data.entities || [];
  }

  /**
   * Find entity ID by path (searches through project file tree)
   */
  async findEntityByPath(projectId: string, targetPath: string): Promise<{
    id: string;
    type: 'doc' | 'file' | 'folder';
    name: string;
  } | null> {
    const projectInfo = await this.getProjectInfo(projectId);
    const normalizedTarget = targetPath.replace(/^\//, '');

    function searchFolder(folder: FolderEntry, currentPath: string): { id: string; type: 'doc' | 'file' | 'folder'; name: string } | null {
      // Check docs
      for (const doc of folder.docs || []) {
        const docPath = currentPath ? `${currentPath}/${doc.name}` : doc.name;
        if (docPath === normalizedTarget || doc.name === normalizedTarget) {
          return { id: doc._id, type: 'doc', name: doc.name };
        }
      }

      // Check files
      for (const file of folder.fileRefs || []) {
        const filePath = currentPath ? `${currentPath}/${file.name}` : file.name;
        if (filePath === normalizedTarget || file.name === normalizedTarget) {
          return { id: file._id, type: 'file', name: file.name };
        }
      }

      // Check subfolders
      for (const subfolder of folder.folders || []) {
        const folderPath = currentPath ? `${currentPath}/${subfolder.name}` : subfolder.name;
        if (folderPath === normalizedTarget || subfolder.name === normalizedTarget) {
          return { id: subfolder._id, type: 'folder', name: subfolder.name };
        }
        const found = searchFolder(subfolder, folderPath);
        if (found) return found;
      }

      return null;
    }

    if (projectInfo.rootFolder?.[0]) {
      return searchFolder(projectInfo.rootFolder[0], '');
    }
    return null;
  }

  /**
   * Download a single file by ID
   */
  async downloadFile(projectId: string, fileId: string, fileType: 'doc' | 'file'): Promise<Buffer> {
    const endpoint = fileType === 'doc' ? 'doc' : 'file';
    const response = await this.httpRequest(`${this.baseUrl}/project/${projectId}/${endpoint}/${fileId}`, {
      headers: this.getHeaders(),
      expect: fileType === 'doc' ? 'json' : 'buffer'
    });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    if (fileType === 'doc') {
      // Docs return JSON with lines array
      const data = response.body as any;
      const content = (data.lines || []).join('\n');
      return Buffer.from(content, 'utf-8');
    } else {
      return response.body as Buffer;
    }
  }

  /**
   * Rename a file, doc, or folder
   */
  async renameEntity(
    projectId: string,
    entityId: string,
    entityType: 'doc' | 'file' | 'folder',
    newName: string
  ): Promise<void> {
    const response = await this.httpRequest(`${this.baseUrl}/project/${projectId}/${entityType}/${entityId}/rename`, {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({ name: newName }),
      expect: 'text'
    });

    if (!response.ok) {
      throw new Error(`Failed to rename entity: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
  }

  /**
   * Delete a file by path
   */
  async deleteByPath(projectId: string, path: string): Promise<void> {
    const entity = await this.findEntityByPath(projectId, path);
    if (!entity) {
      throw new Error(`File not found: ${path}`);
    }
    await this.deleteEntity(projectId, entity.id, entity.type);
  }

  /**
   * Rename a file by path
   */
  async renameByPath(projectId: string, oldPath: string, newName: string): Promise<void> {
    const entity = await this.findEntityByPath(projectId, oldPath);
    if (!entity) {
      throw new Error(`File not found: ${oldPath}`);
    }
    await this.renameEntity(projectId, entity.id, entity.type, newName);
  }

  /**
   * Download a file by path (uses zip as fallback if ID not available)
   */
  async downloadByPath(projectId: string, path: string): Promise<Buffer> {
    const normalizedPath = path.replace(/^\//, '');

    // First check if file exists
    const entities = await this.getEntities(projectId);
    const entityExists = entities.find(e => 
      e.path.replace(/^\//, '') === normalizedPath || 
      e.path === `/${normalizedPath}`
    );

    if (!entityExists) {
      throw new Error(`File not found: ${path}`);
    }

    // Try to find entity with ID for direct download
    try {
      const entity = await this.findEntityByPath(projectId, path);
      if (entity && entity.type !== 'folder') {
        return await this.downloadFile(projectId, entity.id, entity.type);
      }
    } catch (e) {
      // Fall through to zip method
    }

    // Fallback: download zip and extract the file
    const zipBuffer = await this.downloadProject(projectId);
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(zipBuffer);

    for (const entry of zip.getEntries()) {
      if (entry.entryName === normalizedPath || entry.entryName === path) {
        return entry.getData();
      }
    }

    throw new Error(`File not found in archive: ${path}`);
  }

  async getCommentThreads(projectId: string): Promise<Record<string, { messages: CommentMessage[]; resolved?: boolean; resolved_at?: string; resolved_by_user_id?: string }>> {
    const response = await this.httpRequest(`${this.baseUrl}/project/${projectId}/threads`, {
      headers: this.getHeaders(),
      expect: 'json'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch comment threads: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
    return response.body as Record<string, { messages: CommentMessage[]; resolved?: boolean; resolved_at?: string; resolved_by_user_id?: string }>;
  }

  async listComments(projectId: string, options: ListCommentsOptions = {}): Promise<ProjectComment[]> {
    const status = options.status || 'all';
    const contextLines = options.contextLines || 0;
    const projectInfo = await this.getProjectInfo(projectId);
    const docs = this.collectProjectDocs(projectInfo);
    const threads = await this.getCommentThreads(projectId);
    const comments: ProjectComment[] = [];
    const session = await this.openProjectSocket(projectId);

    try {
      for (const doc of docs) {
        const joinedDoc = await this.joinDocument(session, doc.id);

        if (joinedDoc.type === 'history-ot') {
          for (const comment of joinedDoc.ranges.comments || []) {
            const ranges = comment.ranges || [];
            const firstRange = ranges[0];
            if (!firstRange) continue;
            const selectedText = ranges
              .map((range: any) => joinedDoc.content.slice(range.pos, range.pos + range.length))
              .join('');
            const location = this.positionToLineColumn(joinedDoc.content, firstRange.pos);
            const thread = threads[comment.id] || { messages: [] };
            const resolved = Boolean(comment.resolved || thread.resolved);
            comments.push({
              threadId: comment.id,
              docId: doc.id,
              path: doc.path,
              position: firstRange.pos,
              line: location.line,
              column: location.column,
              selectedText,
              resolved,
              messages: thread.messages || [],
              context: this.buildCommentContext(joinedDoc.content, location.line, contextLines)
            });
          }
          continue;
        }

        for (const comment of joinedDoc.ranges.comments || []) {
          const op = comment.op || {};
          const threadId = op.t || comment.id;
          if (!threadId || typeof op.p !== 'number') continue;
          const selectedText = typeof op.c === 'string'
            ? op.c
            : joinedDoc.content.slice(op.p, op.p + (op.c?.length || 0));
          const location = this.positionToLineColumn(joinedDoc.content, op.p);
          const thread = threads[threadId] || { messages: [] };
          const resolved = Boolean(comment.resolved || op.resolved || thread.resolved);
          comments.push({
            threadId,
            docId: doc.id,
            path: doc.path,
            position: op.p,
            line: location.line,
            column: location.column,
            selectedText,
            resolved,
            messages: thread.messages || [],
            context: this.buildCommentContext(joinedDoc.content, location.line, contextLines)
          });
        }
      }
    } finally {
      await this.closeProjectSocket(session);
    }

    return comments
      .filter(comment => {
        if (status === 'all') return true;
        return status === 'resolved' ? comment.resolved : !comment.resolved;
      })
      .sort((a, b) => a.path.localeCompare(b.path) || a.position - b.position);
  }

  async resolveComment(projectId: string, threadId: string): Promise<ProjectComment> {
    const comment = await this.findComment(projectId, threadId);

    const response = await this.httpRequest(
      `${this.baseUrl}/project/${projectId}/doc/${comment.docId}/thread/${threadId}/resolve`,
      {
        method: 'POST',
        headers: this.getHeaders(true),
        body: '',
        expect: 'text'
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to resolve comment: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
    return comment;
  }

  async reopenComment(projectId: string, threadId: string): Promise<ProjectComment> {
    const comment = await this.findComment(projectId, threadId);

    const response = await this.httpRequest(
      `${this.baseUrl}/project/${projectId}/doc/${comment.docId}/thread/${threadId}/reopen`,
      {
        method: 'POST',
        headers: this.getHeaders(true),
        body: '',
        expect: 'text'
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to reopen comment: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
    return comment;
  }

  async deleteComment(projectId: string, threadId: string): Promise<ProjectComment> {
    const comment = await this.findComment(projectId, threadId);

    const response = await this.httpRequest(
      `${this.baseUrl}/project/${projectId}/doc/${comment.docId}/thread/${threadId}`,
      {
        method: 'DELETE',
        headers: this.getHeaders(true),
        body: '',
        expect: 'text'
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to delete comment: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
    return comment;
  }

  private async findComment(projectId: string, threadId: string): Promise<ProjectComment> {
    const comments = await this.listComments(projectId);
    const comment = comments.find(item => item.threadId === threadId);
    if (!comment) {
      throw new Error(`Comment thread not found: ${threadId}`);
    }
    return comment;
  }

  private resolveCommentSelection(doc: JoinedDocument, options: AddCommentOptions): { position: number; selectedText: string } {
    if (options.selectedText) {
      const occurrence = options.occurrence || 1;
      let fromIndex = 0;
      let position = -1;
      for (let index = 0; index < occurrence; index++) {
        position = doc.content.indexOf(options.selectedText, fromIndex);
        if (position === -1) break;
        fromIndex = position + options.selectedText.length;
      }
      if (position === -1) {
        throw new Error(`Selected text not found in ${options.filePath}`);
      }
      return { position, selectedText: options.selectedText };
    }

    let position = options.position;
    if (position == null) {
      if (options.line == null || options.column == null) {
        throw new Error('Add comment requires either --text, --position, or both --line and --column');
      }

      const lines = doc.content.split('\n');
      if (options.line < 1 || options.line > lines.length) {
        throw new Error(`Line out of range: ${options.line}`);
      }
      if (options.column < 1 || options.column > lines[options.line - 1].length + 1) {
        throw new Error(`Column out of range: ${options.column}`);
      }

      position = lines.slice(0, options.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + options.column - 1;
    }

    const length = options.length || 1;
    if (position < 0 || position + length > doc.content.length) {
      throw new Error('Comment selection is outside the document');
    }

    return {
      position,
      selectedText: doc.content.slice(position, position + length)
    };
  }

  async addComment(projectId: string, options: AddCommentOptions): Promise<ProjectComment> {
    const projectInfo = await this.getProjectInfo(projectId);
    const docs = this.collectProjectDocs(projectInfo);
    const normalizedPath = options.filePath.replace(/^\//, '');
    const doc = docs.find(item => item.path === normalizedPath || item.path.replace(/^\//, '') === normalizedPath);
    if (!doc) {
      throw new Error(`Doc not found: ${options.filePath}`);
    }

    const session = await this.openProjectSocket(projectId);
    try {
      const joinedDoc = await this.joinDocument(session, doc.id);
      const selection = this.resolveCommentSelection(joinedDoc, options);
      const threadId = this.generateCommentThreadId();

      await this.postCommentMessage(projectId, threadId, options.content);

      const op = joinedDoc.type === 'history-ot'
        ? {
            commentId: threadId,
            ranges: [{ pos: selection.position, length: selection.selectedText.length }]
          }
        : {
            c: selection.selectedText,
            p: selection.position,
            t: threadId
          };

      await this.socketRpc(session, 'applyOtUpdate', [doc.id, {
        doc: doc.id,
        op: [op],
        v: joinedDoc.version
      }]);

      const location = this.positionToLineColumn(joinedDoc.content, selection.position);
      return {
        threadId,
        docId: doc.id,
        path: doc.path,
        position: selection.position,
        line: location.line,
        column: location.column,
        selectedText: selection.selectedText,
        resolved: false,
        messages: []
      };
    } finally {
      await this.closeProjectSocket(session);
    }
  }

  async postCommentMessage(projectId: string, threadId: string, content: string): Promise<CommentMessage | null> {
    const response = await this.httpRequest(`${this.baseUrl}/project/${projectId}/thread/${threadId}/messages`, {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({ content }),
      expect: 'text'
    });

    if (!response.ok) {
      throw new Error(`Failed to post comment message: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);
    if (!response.body) return null;
    try {
      return JSON.parse(response.body as string) as CommentMessage;
    } catch {
      return null;
    }
  }

  /**
   * Compile project and get all output files
   */
  async compileWithOutputs(projectId: string): Promise<{
    status: 'success' | 'failure' | 'error';
    pdfUrl?: string;
    outputFiles: { path: string; type: string; url: string }[];
  }> {
    const response = await this.httpRequest(this.compileUrl(projectId), {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({
        rootDoc_id: null,
        draft: false,
        check: 'silent',
        incrementalCompilesEnabled: true
      }),
      expect: 'json'
    });

    if (!response.ok) {
      throw new Error(`Failed to compile project: ${response.status}`);
    }

    this.applySetCookieHeaders(response.headers['set-cookie'] as string[] | undefined);

    const data = response.body as any;
    // Prefer 'output.pdf' (the main compile output) over any other PDF.
    // See #26 — projects with figure PDFs could return the wrong file.
    const pdfFile = data.outputFiles?.find((f: any) => f.path === 'output.pdf')
      || data.outputFiles?.find((f: any) => f.type === 'pdf');

    // Overleaf's CDN requires ?clsiserverid=<id> for build-output downloads.
    // Without it every output (pdf/log/bbl/...) 404s. See issue #22.
    const qs = data.clsiServerId ? `?clsiserverid=${encodeURIComponent(data.clsiServerId)}` : '';
    return {
      status: data.status,
      pdfUrl: pdfFile ? `${this.baseUrl}${pdfFile.url}${qs}` : undefined,
      outputFiles: (data.outputFiles || []).map((f: any) => ({
        path: f.path,
        type: f.type,
        url: `${this.baseUrl}${f.url}${qs}`
      }))
    };
  }

  /**
   * Download a compile output file (logs, bbl, aux, etc.)
   */
  async downloadOutputFile(url: string): Promise<Buffer> {
    return this.downloadBuffer(url);
  }
}
