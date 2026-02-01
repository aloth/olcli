/**
 * Overleaf API Client
 *
 * Provides programmatic access to Overleaf's REST APIs for project
 * management, file operations, and LaTeX compilation.
 */

import * as cheerio from 'cheerio';
import { CookieJar, Cookie } from 'tough-cookie';

const BASE_URL = 'https://www.overleaf.com';
const PROJECT_URL = `${BASE_URL}/project`;
const DOWNLOAD_URL = `${BASE_URL}/project/{id}/download/zip`;
const UPLOAD_URL = `${BASE_URL}/project/{id}/upload`;
const FOLDER_URL = `${BASE_URL}/project/{id}/folder`;
const DELETE_URL = `${BASE_URL}/project/{projectId}/{type}/{entityId}`;
const COMPILE_URL = `${BASE_URL}/project/{id}/compile?enable_pdf_caching=true`;

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

export interface Credentials {
  cookies: Record<string, string>;
  csrf: string;
}

export class OverleafClient {
  private cookies: Record<string, string>;
  private csrf: string;

  constructor(credentials: Credentials) {
    this.cookies = credentials.cookies;
    this.csrf = credentials.csrf;
  }

  /**
   * Create client from session cookie string
   */
  static async fromSessionCookie(sessionCookie: string): Promise<OverleafClient> {
    const cookies: Record<string, string> = {
      'overleaf_session2': sessionCookie
    };

    // Fetch CSRF token from project page
    const response = await fetch(PROJECT_URL, {
      headers: {
        'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        'User-Agent': 'olcli/0.1.0'
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

    return new OverleafClient({ cookies, csrf });
  }

  private getCookieHeader(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private getHeaders(includeContentType = false): Record<string, string> {
    const headers: Record<string, string> = {
      'Cookie': this.getCookieHeader(),
      'User-Agent': 'olcli/0.1.0',
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
    const response = await fetch(PROJECT_URL, {
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
    const response = await fetch(`${PROJECT_URL}/${projectId}`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch project info: ${response.status}`);
    }

    const html = await response.text();
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

    if (!projectInfo) {
      throw new Error('Could not parse project info');
    }

    return projectInfo;
  }

  /**
   * Download project as zip
   */
  async downloadProject(projectId: string): Promise<Buffer> {
    const response = await fetch(DOWNLOAD_URL.replace('{id}', projectId), {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to download project: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Compile project and get PDF
   */
  async compileProject(projectId: string): Promise<{ pdfUrl: string; logs: string[] }> {
    const response = await fetch(COMPILE_URL.replace('{id}', projectId), {
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
      pdfUrl: `${BASE_URL}${pdfFile.url}`,
      logs: data.compileGroup ? [`Compile group: ${data.compileGroup}`] : []
    };
  }

  /**
   * Download compiled PDF
   */
  async downloadPdf(projectId: string): Promise<Buffer> {
    const { pdfUrl } = await this.compileProject(projectId);

    const response = await fetch(pdfUrl, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Create a folder in a project
   */
  async createFolder(projectId: string, parentFolderId: string, name: string): Promise<string> {
    const response = await fetch(FOLDER_URL.replace('{id}', projectId), {
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

    // Method 2: Compute from project ID (projectId - 1)
    return this.computeRootFolderId(projectId);
  }

  /**
   * Upload a file to a project
   * Based on Overleaf-Workshop implementation and fix from PR #73 for filename handling
   */
  async uploadFile(
    projectId: string,
    folderId: string | null,
    fileName: string,
    content: Buffer
  ): Promise<{ success: boolean; entityId?: string; entityType?: string }> {
    // If no folder ID provided, get the root folder
    const targetFolderId = folderId || await this.getRootFolderId(projectId);

    // Extract just the filename without path (PR #73 fix)
    const baseName = fileName.split('/').pop() || fileName;

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

    const formData = new FormData();
    // Match Overleaf-Workshop: include targetFolderId in form data
    formData.append('targetFolderId', targetFolderId);
    formData.append('name', baseName);
    formData.append('type', mimeType);
    formData.append('qqfile', new Blob([content]), baseName);

    const response = await fetch(`${UPLOAD_URL.replace('{id}', projectId)}?folder_id=${targetFolderId}`, {
      method: 'POST',
      headers: {
        'Cookie': this.getCookieHeader(),
        'User-Agent': 'olcli/0.1.0',
        'X-Csrf-Token': this.csrf
      },
      body: formData
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to upload file: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;
    return {
      success: data.success !== false,
      entityId: data.entity_id,
      entityType: data.entity_type
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
    const url = DELETE_URL
      .replace('{projectId}', projectId)
      .replace('{type}', entityType)
      .replace('{entityId}', entityId);

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
    const response = await fetch(`${BASE_URL}/project/${projectId}/entities`, {
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
    const response = await fetch(`${BASE_URL}/project/${projectId}/${endpoint}/${fileId}`, {
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
    const response = await fetch(`${BASE_URL}/project/${projectId}/${entityType}/${entityId}/rename`, {
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
    const response = await fetch(COMPILE_URL.replace('{id}', projectId), {
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
      pdfUrl: pdfFile ? `${BASE_URL}${pdfFile.url}` : undefined,
      outputFiles: (data.outputFiles || []).map((f: any) => ({
        path: f.path,
        type: f.type,
        url: `${BASE_URL}${f.url}`
      }))
    };
  }

  /**
   * Download a compile output file (logs, bbl, aux, etc.)
   */
  async downloadOutputFile(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to download output file: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
