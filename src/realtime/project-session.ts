import { OlcliError } from '../errors/olcli-error.js';
import { DocumentSession } from './document-session.js';
import type { RealtimeTransport } from './transport.js';

export interface RealtimeDocumentRef {
  id: string;
  path: string;
}

export class ProjectSession {
  readonly projectId: string;

  private readonly transport: RealtimeTransport;
  private readonly documents = new Set<DocumentSession>();

  constructor(transport: RealtimeTransport) {
    this.transport = transport;
    this.projectId = transport.projectId;
  }

  get isOpen(): boolean {
    return this.transport.isOpen;
  }

  get joinProjectArgs(): readonly unknown[] | undefined {
    return this.transport.joinProjectArgs;
  }

  async open(): Promise<this> {
    await this.transport.open();
    return this;
  }

  openDocument(docId: string, path?: string): DocumentSession {
    if (!this.isOpen) throw new OlcliError('PROTOCOL_ERROR', 'Project session is not open');
    const session = new DocumentSession(this.transport, docId, path);
    this.documents.add(session);
    return session;
  }

  listDocuments(): RealtimeDocumentRef[] {
    const project = (this.joinProjectArgs?.[0] as { project?: { rootFolder?: unknown[] } } | undefined)?.project;
    const rootFolders = Array.isArray(project?.rootFolder) ? project.rootFolder : [];
    const documents: RealtimeDocumentRef[] = [];

    const walk = (rawFolder: unknown, parentPath: string): void => {
      if (!rawFolder || typeof rawFolder !== 'object') return;
      const folder = rawFolder as { name?: unknown; docs?: unknown[]; folders?: unknown[] };
      for (const rawDoc of Array.isArray(folder.docs) ? folder.docs : []) {
        if (!rawDoc || typeof rawDoc !== 'object') continue;
        const doc = rawDoc as { _id?: unknown; name?: unknown };
        if (typeof doc._id !== 'string' || typeof doc.name !== 'string') continue;
        documents.push({
          id: doc._id,
          path: parentPath ? `${parentPath}/${doc.name}` : doc.name,
        });
      }
      for (const rawChild of Array.isArray(folder.folders) ? folder.folders : []) {
        if (!rawChild || typeof rawChild !== 'object') continue;
        const name = (rawChild as { name?: unknown }).name;
        if (typeof name !== 'string') continue;
        walk(rawChild, parentPath ? `${parentPath}/${name}` : name);
      }
    };

    for (const rootFolder of rootFolders) walk(rootFolder, '');
    return documents.sort((a, b) => a.path.localeCompare(b.path));
  }

  findDocument(path: string): RealtimeDocumentRef | undefined {
    const normalizedPath = path.replace(/^\/+/, '');
    return this.listDocuments().find(
      document => document.path.replace(/^\/+/, '') === normalizedPath
    );
  }

  openDocumentByPath(path: string): DocumentSession {
    const document = this.findDocument(path);
    if (!document) {
      throw new OlcliError('DOCUMENT_NOT_FOUND', `Document not found: ${path}`, {
        details: { projectId: this.projectId, path },
      });
    }
    return this.openDocument(document.id, document.path);
  }

  async close(): Promise<void> {
    for (const document of this.documents) document.close();
    this.documents.clear();
    await this.transport.close();
  }
}
