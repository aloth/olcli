import { OlcliError } from '../errors/olcli-error.js';
import { normalizeJoinedDocument } from './document-normalizer.js';
import type { JoinedDocument } from './types.js';
import type { RealtimeTransport } from './transport.js';

export interface DocumentSubmitInput {
  operations: unknown[];
  expectedVersion: number;
  metadata?: Record<string, unknown>;
}

export interface DocumentSubmitResult {
  docId: string;
  submittedVersion: number;
  acknowledgement: unknown[];
}

export class DocumentSession {
  readonly docId: string;
  readonly path?: string;

  private readonly transport: RealtimeTransport;
  private current?: JoinedDocument;
  private closed = false;

  constructor(transport: RealtimeTransport, docId: string, path?: string) {
    this.transport = transport;
    this.docId = docId;
    this.path = path;
  }

  get snapshot(): JoinedDocument | undefined {
    return this.current;
  }

  async join(): Promise<JoinedDocument> {
    if (this.closed) throw new OlcliError('PROTOCOL_ERROR', 'Document session is closed');
    if (this.current) return this.current;
    return this.readSnapshot();
  }

  async refresh(): Promise<JoinedDocument> {
    if (this.closed) throw new OlcliError('PROTOCOL_ERROR', 'Document session is closed');
    return this.readSnapshot();
  }

  async submit(input: DocumentSubmitInput): Promise<DocumentSubmitResult> {
    if (this.closed) throw new OlcliError('PROTOCOL_ERROR', 'Document session is closed');
    const snapshot = this.current ?? await this.join();
    if (snapshot.version !== input.expectedVersion) {
      throw new OlcliError('VERSION_CONFLICT', 'Document version no longer matches the expected version', {
        details: {
          docId: this.docId,
          expectedVersion: input.expectedVersion,
          actualVersion: snapshot.version,
        },
      });
    }

    const update: Record<string, unknown> = {
      doc: this.docId,
      op: input.operations,
      v: input.expectedVersion,
    };
    if (input.metadata && Object.keys(input.metadata).length > 0) update.meta = input.metadata;

    const acknowledgement = await this.transport.rpc('applyOtUpdate', [this.docId, update]);
    // Force an explicit refresh before another mutation. The acknowledgement
    // shape is undocumented and is not treated as an authoritative snapshot.
    this.current = undefined;
    return {
      docId: this.docId,
      submittedVersion: input.expectedVersion,
      acknowledgement,
    };
  }

  close(): void {
    this.closed = true;
    this.current = undefined;
  }

  private async readSnapshot(): Promise<JoinedDocument> {
    const args = await this.transport.rpc('joinDoc', [
      this.docId,
      { encodeRanges: true, supportsHistoryOT: true },
    ]);
    this.current = normalizeJoinedDocument(this.docId, args);
    return this.current;
  }
}
