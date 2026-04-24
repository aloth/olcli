/**
 * Overleaf API Client
 *
 * Provides programmatic access to Overleaf's REST APIs for project
 * management, file operations, and LaTeX compilation.
 */

import * as cheerio from 'cheerio';
import { CookieJar, Cookie } from 'tough-cookie';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSessionCookie,
  setSessionCookie,
  getLastProject,
  setLastProject,
  getConfigPath,
  saveOlAuth,
  clearConfig,
  getBaseUrl,
  setBaseUrl,
  getSessionCookieName,
  setSessionCookieName
} from './config.js';

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
  version: number;
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

export interface Credentials {
  cookies: Record<string, string>;
  csrf: string;
  baseUrl?: string;
}

/**
 * Helper to get authenticated client
 */
export async function getClient(cookieOpt?: string, baseUrlOpt?: string): Promise<OverleafClient> {
  const cookie = cookieOpt || getSessionCookie();
  if (!cookie) {
    console.error('No session cookie found.');
    console.error('Set one with: olcli auth --cookie <session_cookie>');
    console.error('Or set OVERLEAF_SESSION environment variable');
    console.error('Or create .olauth file in current directory');
    process.exit(1);
  }
  const baseUrl = baseUrlOpt || getBaseUrl();
  const cookieName = getSessionCookieName();
  return OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
}

export class OverleafClient {
  private cookies: Record<string, string>;
  private csrf: string;
  private baseUrl: string;

  constructor(credentials: Credentials) {
    this.cookies = credentials.cookies;
    this.csrf = credentials.csrf;
    this.baseUrl = credentials.baseUrl || DEFAULT_BASE_URL;
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
    const response = await fetch(`${baseUrl}/project`, {
      headers: {
        'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
          'User-Agent': USER_AGENT
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch projects page: ${response.status} ${response.statusText}`);
    }

    // Capture any new cookies from response
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    for (const setCookie of setCookieHeaders) {
      const match = setCookie.match(/^([^=]+)=([^;]+)/);
      if (match) {
        cookies[match[1]] = match[2];
      }
    }

    const html = await response.text();
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

    return new OverleafClient({ cookies, csrf, baseUrl });
  }

  private getCookieHeader(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private applySetCookieHeaders(headers: Headers): void {
    const setCookieHeaders = headers.getSetCookie?.() || [];
    for (const setCookie of setCookieHeaders) {
      const match = setCookie.match(/^([^=]+)=([^;]+)/);
      if (match) {
        this.cookies[match[1]] = match[2];
      }
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
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

  /**
   * Get all projects (not archived, not trashed)
   */
  async listProjects(): Promise<Project[]> {
    const response = await fetch(this.projectUrl(), {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch projects: ${response.status}`);
    }

    const html = await response.text();
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
   * Apply a Label to the current overleaf state
   */
  async applyOverleafLabel(projectId: string, message: string, version: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 100));

    const url = `${this.baseUrl}/project/${projectId}/labels`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({
        comment: message,
        version: version
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to create label: ${response.status}`);
    }
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
   * Get detailed project info including file tree (via WebSocket)
   */
  async getProjectInfo(projectId: string): Promise<ProjectInfo> {
    let sid: string | null = null;

    try {
      // 1. Initiate Socket.io Handshake
      const handshakeUrl = `${this.baseUrl}/socket.io/1/?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
      const handshakeResponse = await this.fetchWithTimeout(handshakeUrl, {
        headers: { 'Cookie': this.getCookieHeader(), 'User-Agent': USER_AGENT }
      }, 5000);

      if (!handshakeResponse.ok) throw new Error(`Socket handshake failed: ${handshakeResponse.status}`);
      this.applySetCookieHeaders(handshakeResponse.headers);

      const handshakeBody = (await handshakeResponse.text()).trim();
      sid = handshakeBody.split(':')[0];
      if (!sid) throw new Error('Could not parse socket session ID');

      // 2. Poll the socket for the project data
      const pollUrl = `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;

      for (let attempt = 0; attempt < 3; attempt++) {
        const pollResponse = await this.fetchWithTimeout(pollUrl, {
          headers: { 'Cookie': this.getCookieHeader(), 'User-Agent': USER_AGENT }
        }, 5000);

        if (!pollResponse.ok) throw new Error(`Socket poll failed: ${pollResponse.status}`);
        this.applySetCookieHeaders(pollResponse.headers);

        const payload = await pollResponse.text();
        const packets = this.decodeSocketIoPayload(payload);

        for (const packet of packets) {
          // Look for the main event packet
          if (packet.startsWith('5:::')) {
            try {
              const payloadJson = JSON.parse(packet.slice(4));
              if (payloadJson?.name === 'joinProjectResponse') {
                const projectData = payloadJson?.args?.[0]?.project;

                if (projectData) {
                  // Map the socket data to the strict TypeScript ProjectInfo interface
                  //console.error(projectData.version);
                  return {
                    _id: projectData._id,
                    name: projectData.name,
                    rootDoc_id: projectData.rootDoc_id,
                    rootFolder: projectData.rootFolder,
                    version: parseInt(projectData.version) // <-- Add this line!
                  };
                }
              }
            } catch (e) { }
          }

          // Reply to heartbeat
          if (packet.startsWith('2::')) {
            await this.fetchWithTimeout(pollUrl, {
              method: 'POST',
              headers: { 'Cookie': this.getCookieHeader(), 'User-Agent': USER_AGENT, 'Content-Type': 'text/plain;charset=UTF-8' },
              body: '2::'
            }, 5000);
          }
        }
      }
    } finally {
      // 3. Cleanly disconnect the socket
      if (sid) {
        try {
          const disconnectUrl = `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;
          await this.fetchWithTimeout(disconnectUrl, {
            method: 'POST',
            headers: { 'Cookie': this.getCookieHeader(), 'User-Agent': USER_AGENT, 'Content-Type': 'text/plain;charset=UTF-8' },
            body: '0::'
          }, 5000);
        } catch { /* ignore */ }
      }
    }

    throw new Error('Could not parse project info from WebSocket');
  }


  /**
   * Download a URL as a Buffer using Node.js http/https modules.
   *
   * This avoids fetch's strict header validation which rejects non-Latin1
   * characters in response headers (e.g. Content-Disposition with Unicode
   * project names). See: https://github.com/aloth/olcli/issues/2
   */
  private async downloadBuffer(url: string): Promise<Buffer> {
    const { default: https } = await import('node:https');
    const { default: http } = await import('node:http');

    const doRequest = (reqUrl: string): Promise<Buffer> => {
      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(reqUrl);
        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const req = transport.get(reqUrl, {
          headers: this.getHeaders(),
        }, (res) => {
          // Follow redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, reqUrl).toString();
            doRequest(redirectUrl).then(resolve, reject);
            return;
          }

          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Download failed: ${res.statusCode}`));
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('error', reject);
      });
    };

    return doRequest(url);
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
    const response = await fetch(this.compileUrl(projectId), {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({
        rootDoc_id: null,
        draft: false,
        check: 'silent',
        incrementalCompilesEnabled: true
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to compile project: ${response.status}`);
    }

    const data = await response.json() as any;

    if (data.status !== 'success') {
      throw new Error(`Compilation failed: ${data.status}`);
    }

    const pdfFile = data.outputFiles?.find((f: any) => f.type === 'pdf');
    if (!pdfFile) {
      throw new Error('No PDF output found');
    }

    return {
      pdfUrl: `${this.baseUrl}${pdfFile.url}`,
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
    const response = await fetch(this.folderUrl(projectId), {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({
        parent_folder_id: parentFolderId,
        name
      })
    });

    if (response.status === 400) {
      // Folder already exists
      throw new Error('Folder already exists');
    }

    if (!response.ok) {
      throw new Error(`Failed to create folder: ${response.status}`);
    }

    const data = await response.json() as any;
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
      const handshakeResponse = await this.fetchWithTimeout(handshakeUrl, {
        headers: {
          'Cookie': this.getCookieHeader(),
          'User-Agent': USER_AGENT
        }
      }, 5000);

      if (!handshakeResponse.ok) return null;
      this.applySetCookieHeaders(handshakeResponse.headers);

      const handshakeBody = (await handshakeResponse.text()).trim();
      sid = handshakeBody.split(':')[0];
      if (!sid) return null;

      const buildPollUrl = () =>
      `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;

      let discoveredRootFolderId: string | null = null;

      // poll a few frames, first is usually connect ack, next includes joinProjectResponse
      for (let attempt = 0; attempt < 3; attempt++) {
        const pollResponse = await this.fetchWithTimeout(buildPollUrl(), {
          headers: {
            'Cookie': this.getCookieHeader(),
            'User-Agent': USER_AGENT
          }
        }, 5000);

        if (!pollResponse.ok) return null;
        this.applySetCookieHeaders(pollResponse.headers);

        const payload = await pollResponse.text();
        const packets = this.decodeSocketIoPayload(payload);

        for (const packet of packets) {
          const rootFolderId = this.extractRootFolderIdFromSocketPacket(packet);
          if (rootFolderId) {
            discoveredRootFolderId = rootFolderId;
            break;
          }

          if (packet.startsWith('2::')) {
            //reply to heartbeat to keep polling transport alive
            const heartbeatResponse = await this.fetchWithTimeout(buildPollUrl(), {
              method: 'POST',
              headers: {
                'Cookie': this.getCookieHeader(),
                'User-Agent': USER_AGENT,
                'Content-Type': 'text/plain;charset=UTF-8'
              },
              body: '2::'
            }, 5000);
            this.applySetCookieHeaders(heartbeatResponse.headers);
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
          const disconnectResponse = await this.fetchWithTimeout(disconnectUrl, {
            method: 'POST',
            headers: {
              'Cookie': this.getCookieHeader(),
              'User-Agent': USER_AGENT,
              'Content-Type': 'text/plain;charset=UTF-8'
            },
            body: '0::'
          }, 5000);
          this.applySetCookieHeaders(disconnectResponse.headers);
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
      const handshakeResponse = await this.fetchWithTimeout(handshakeUrl, {
        headers: {
          'Cookie': this.getCookieHeader(),
          'User-Agent': USER_AGENT
        }
      }, 5000);

      if (!handshakeResponse.ok) return null;
      this.applySetCookieHeaders(handshakeResponse.headers);

      const handshakeBody = (await handshakeResponse.text()).trim();
      sid = handshakeBody.split(':')[0];
      if (!sid) return null;

      const buildPollUrl = () =>
      `${this.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`;

      for (let attempt = 0; attempt < 3; attempt++) {
        const pollResponse = await this.fetchWithTimeout(buildPollUrl(), {
          headers: {
            'Cookie': this.getCookieHeader(),
            'User-Agent': USER_AGENT
          }
        }, 5000);

        if (!pollResponse.ok) return null;
        this.applySetCookieHeaders(pollResponse.headers);

        const payload = await pollResponse.text();
        const packets = this.decodeSocketIoPayload(payload);

        for (const packet of packets) {
          const folderTree = this.extractFolderTreeFromSocketPacket(packet);
          if (folderTree) return folderTree;

          if (packet.startsWith('2::')) {
            const heartbeatResponse = await this.fetchWithTimeout(buildPollUrl(), {
              method: 'POST',
              headers: {
                'Cookie': this.getCookieHeader(),
                'User-Agent': USER_AGENT,
                'Content-Type': 'text/plain;charset=UTF-8'
              },
              body: '2::'
            }, 5000);
            this.applySetCookieHeaders(heartbeatResponse.headers);
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
          await this.fetchWithTimeout(disconnectUrl, {
            method: 'POST',
            headers: {
              'Cookie': this.getCookieHeader(),
              'User-Agent': USER_AGENT,
              'Content-Type': 'text/plain;charset=UTF-8'
            },
            body: '0::'
          }, 5000);
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

        const response = await fetch(`${this.uploadUrl(projectId)}?folder_id=${folderId}`, {
          method: 'POST',
          headers: {
            'Cookie': this.getCookieHeader(),
            'User-Agent': USER_AGENT,
            'X-Csrf-Token': this.csrf
          },
          body: formData
        });

        const data = await response.json() as any;
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

    // Resolve target folder: if fileName has a directory part and we have a folderTree, use it
    const dirPart = fileName.includes('/') ? fileName.split('/').slice(0, -1).join('/') : '';
    let targetFolderId: string;
    if (dirPart && folderTree) {
      targetFolderId = await this.resolveFolderId(projectId, folderTree, dirPart);
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

      const response = await fetch(`${this.uploadUrl(projectId)}?folder_id=${encodeURIComponent(fid)}`, {
        method: 'POST',
        headers: {
          'Cookie': this.getCookieHeader(),
          'User-Agent': USER_AGENT,
          'X-Csrf-Token': this.csrf
        },
        body: formData
      });

      if (!response.ok) {
        const text = await response.text();
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

      const data = await response.json() as any;
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

    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to delete entity: ${response.status}`);
    }
  }

  /**
   * Get list of entities (files/docs) with paths
   */
  async getEntities(projectId: string): Promise<{ path: string; type: 'doc' | 'file' }[]> {
    const response = await fetch(`${this.baseUrl}/project/${projectId}/entities`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to get entities: ${response.status}`);
    }

    const data = await response.json() as any;
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
    const response = await fetch(`${this.baseUrl}/project/${projectId}/${endpoint}/${fileId}`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }

    if (fileType === 'doc') {
      // Docs return JSON with lines array
      const data = await response.json() as any;
      const content = (data.lines || []).join('\n');
      return Buffer.from(content, 'utf-8');
    } else {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
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
    const response = await fetch(`${this.baseUrl}/project/${projectId}/${entityType}/${entityId}/rename`, {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({ name: newName })
    });

    if (!response.ok) {
      throw new Error(`Failed to rename entity: ${response.status}`);
    }
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

  /**
   * Compile project and get all output files
   */
  async compileWithOutputs(projectId: string): Promise<{
    status: 'success' | 'failure' | 'error';
    pdfUrl?: string;
    outputFiles: { path: string; type: string; url: string }[];
  }> {
    const response = await fetch(this.compileUrl(projectId), {
      method: 'POST',
      headers: this.getHeaders(true),
      body: JSON.stringify({
        rootDoc_id: null,
        draft: false,
        check: 'silent',
        incrementalCompilesEnabled: true
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to compile project: ${response.status}`);
    }

    const data = await response.json() as any;
    const pdfFile = data.outputFiles?.find((f: any) => f.type === 'pdf');

    return {
      status: data.status,
      pdfUrl: pdfFile ? `${this.baseUrl}${pdfFile.url}` : undefined,
      outputFiles: (data.outputFiles || []).map((f: any) => ({
        path: f.path,
        type: f.type,
        url: `${this.baseUrl}${f.url}`
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
