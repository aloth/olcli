import { describe, expect, it } from 'vitest';

import type { RealtimeTransport } from '../../src/realtime/transport.js';
import { DocumentSession } from '../../src/realtime/document-session.js';
import { ProjectSession } from '../../src/realtime/project-session.js';

class FakeTransport implements RealtimeTransport {
  readonly projectId = 'project-1';
  isOpen = false;
  joinProjectArgs: readonly unknown[] | undefined = [{
    project: {
      rootFolder: [{
        _id: 'root',
        docs: [{ _id: 'doc-main', name: 'main.tex' }],
        folders: [{
          _id: 'folder-1',
          name: 'chapters',
          docs: [{ _id: 'doc-one', name: 'one.tex' }],
          folders: [],
        }],
      }],
    },
  }];
  calls: Array<{ name: string; args: unknown[] }> = [];
  replies: unknown[][] = [];

  async open(): Promise<void> {
    this.isOpen = true;
  }

  async rpc(name: string, args: unknown[]): Promise<unknown[]> {
    this.calls.push({ name, args });
    const reply = this.replies.shift();
    if (!reply) throw new Error(`No fake reply for ${name}`);
    return reply;
  }

  async close(): Promise<void> {
    this.isOpen = false;
  }
}

describe('real-time sessions', () => {
  it('locates nested documents and normalizes legacy snapshots', async () => {
    const transport = new FakeTransport();
    const project = await new ProjectSession(transport).open();
    expect(project.listDocuments()).toEqual([
      { id: 'doc-one', path: 'chapters/one.tex' },
      { id: 'doc-main', path: 'main.tex' },
    ]);
    expect(project.findDocument('/chapters/one.tex')).toEqual({
      id: 'doc-one',
      path: 'chapters/one.tex',
    });

    transport.replies.push([
      ['cafÃ©'],
      4,
      [],
      { comments: [{ op: { p: 0, c: 'cafÃ©', t: 'thread-1' } }] },
      'sharejs-text-ot',
    ]);
    const document = project.openDocumentByPath('chapters/one.tex');
    const snapshot = await document.join();
    expect(snapshot).toMatchObject({
      content: 'café',
      version: 4,
      type: 'sharejs-text-ot',
      ranges: { comments: [{ op: { c: 'café' } }] },
    });
    await project.close();
    await expect(document.refresh()).rejects.toThrow(/closed/);
  });

  it('normalizes history-OT and enforces local version preconditions', async () => {
    const transport = new FakeTransport();
    transport.isOpen = true;
    transport.replies.push([
      { content: 'hello', comments: [] },
      9,
      [],
      undefined,
      'history-ot',
    ]);
    const document = new DocumentSession(transport, 'doc-main', 'main.tex');
    expect(await document.join()).toMatchObject({ content: 'hello', version: 9, type: 'history-ot' });

    await expect(document.submit({ operations: [], expectedVersion: 8 }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(transport.calls).toHaveLength(1);

    transport.replies.push([{ accepted: true }]);
    await expect(document.submit({
      operations: [{ i: '!', p: 5 }],
      expectedVersion: 9,
      metadata: { tc: 'seed' },
    })).resolves.toMatchObject({ submittedVersion: 9 });
    expect(transport.calls[1]).toEqual({
      name: 'applyOtUpdate',
      args: ['doc-main', {
        doc: 'doc-main',
        op: [{ i: '!', p: 5 }],
        v: 9,
        meta: { tc: 'seed' },
      }],
    });
    expect(document.snapshot).toBeUndefined();
  });
});
