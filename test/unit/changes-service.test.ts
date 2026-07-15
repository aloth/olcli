import { describe, expect, it } from 'vitest';

import { ChangesService, type SaveTrackChangesBody } from '../../src/changes/service.js';
import type { TrackChangesState } from '../../src/changes/types.js';
import { ProjectSession } from '../../src/realtime/project-session.js';
import type { RealtimeTransport } from '../../src/realtime/transport.js';

const beforeJoin = [
  ['alpha old omega'],
  7,
  [],
  { changes: [] },
  'sharejs-text-ot',
];

const afterJoin = [
  ['alpha new omega'],
  8,
  [],
  {
    changes: [
      {
        id: 'new-insert',
        op: { p: 6, i: 'new' },
        metadata: { user_id: 'user-1', ts: '2026-07-13T00:00:00.000Z' },
      },
      {
        id: 'new-delete',
        op: { p: 9, d: 'old' },
        metadata: { user_id: 'user-1', ts: '2026-07-13T00:00:00.000Z' },
      },
    ],
  },
  'sharejs-text-ot',
];

class ServiceTransport implements RealtimeTransport {
  readonly projectId = 'project-1';
  isOpen = false;
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  readonly joinProjectArgs: readonly unknown[];
  private readonly joinReplies: unknown[][];

  constructor(state: TrackChangesState, joinReplies: unknown[][] = []) {
    this.joinReplies = [...joinReplies];
    this.joinProjectArgs = [{
      permissionsLevel: 'owner',
      project: {
        features: { trackChanges: true, trackChangesVisible: true },
        trackChangesState: state,
        rootFolder: [{
          _id: 'root',
          name: 'root',
          docs: [{ _id: 'doc-1', name: 'main.tex' }],
          folders: [],
        }],
      },
    }];
  }

  async open(): Promise<void> { this.isOpen = true; }

  async rpc(name: string, args: unknown[]): Promise<unknown[]> {
    this.calls.push({ name, args });
    if (name === 'joinDoc') {
      const reply = this.joinReplies.shift();
      if (!reply) throw new Error('No join reply');
      return reply;
    }
    if (name === 'applyOtUpdate') return [];
    throw new Error(`Unexpected RPC: ${name}`);
  }

  async close(): Promise<void> { this.isOpen = false; }
}

class ServiceHost {
  currentUserId = 'user-1';
  state: TrackChangesState;
  stateWrites: SaveTrackChangesBody[] = [];
  acceptedChanges: Array<{ projectId: string; docId: string; changeIds: string[] }> = [];
  readonly mainTransport: ServiceTransport;

  constructor(joinReplies: unknown[][], state: TrackChangesState = false) {
    this.state = state;
    this.mainTransport = new ServiceTransport(this.state, joinReplies);
  }

  async openProjectSession(): Promise<ProjectSession> {
    const transport = this.mainTransport.isOpen || this.mainTransport.calls.length > 0
      ? new ServiceTransport(this.state)
      : this.mainTransport;
    return new ProjectSession(transport).open();
  }

  async saveTrackChanges(_projectId: string, body: SaveTrackChangesBody): Promise<void> {
    this.stateWrites.push(body);
    if (typeof body.on === 'boolean') {
      this.state = body.on;
      return;
    }
    const explicitState = {
      ...(body.on_for || {}),
      ...(typeof body.on_for_guests === 'boolean' ? { __guests__: body.on_for_guests } : {}),
    };
    this.state = Object.values(explicitState).some(Boolean) ? explicitState : false;
  }

  async acceptShareJsChanges(
    projectId: string,
    docId: string,
    changeIds: string[]
  ): Promise<void> {
    this.acceptedChanges.push({ projectId, docId, changeIds });
  }
}

const pendingReplacementJoin = [
  ['alpha new omega'],
  8,
  [],
  {
    changes: [
      {
        id: 'new-insert',
        op: { p: 6, i: 'new' },
        metadata: { user_id: 'user-1', ts: '2026-07-13T00:00:00.000Z' },
      },
      {
        id: 'new-delete',
        op: { p: 9, d: 'old' },
        metadata: { user_id: 'user-1', ts: '2026-07-13T00:00:00.000Z' },
      },
    ],
  },
  'sharejs-text-ot',
];

const acceptedReplacementJoin = [
  ['alpha new omega'],
  9,
  [],
  { changes: [] },
  'sharejs-text-ot',
];

const rejectedReplacementJoin = [
  ['alpha old omega'],
  9,
  [],
  { changes: [] },
  'sharejs-text-ot',
];

const pendingHistoryReplacementJoin = [
  {
    content: 'alpha newold omega',
    trackedChanges: [
      {
        range: { pos: 6, length: 3 },
        tracking: {
          type: 'insert',
          userId: 'user-1',
          ts: '2026-07-13T00:00:00.000Z',
        },
      },
      {
        range: { pos: 9, length: 3 },
        tracking: {
          type: 'delete',
          userId: 'user-1',
          ts: '2026-07-13T00:00:00.000Z',
        },
      },
    ],
  },
  8,
  [],
  null,
  'history-ot',
];

const rejectedHistoryReplacementJoin = [
  { content: 'alpha old omega', trackedChanges: [] },
  9,
  [],
  null,
  'history-ot',
];

describe('ChangesService', () => {
  it('previews a targeted replacement without changing project state', async () => {
    const host = new ServiceHost([beforeJoin]);
    const preview = await new ChangesService(host).previewTrackedSuggestion({
      projectId: 'project-1',
      filePath: 'main.tex',
      oldText: 'old',
      newText: 'new',
    });

    expect(preview).toMatchObject({
      version: 7,
      position: 6,
      line: 1,
      column: 7,
      operations: [
        { kind: 'insert', position: 6, text: 'new' },
        { kind: 'delete', position: 9, text: 'old' },
      ],
    });
    expect(host.stateWrites).toEqual([]);
  });

  it('submits once, verifies new ranges, and restores the exact prior state', async () => {
    const host = new ServiceHost([beforeJoin, beforeJoin, afterJoin]);
    const result = await new ChangesService(host).suggestTrackedChange({
      projectId: 'project-1',
      filePath: 'main.tex',
      oldText: 'old',
      newText: 'new',
      precondition: { expectedVersion: 7 },
    });

    expect(result).toMatchObject({
      beforeVersion: 7,
      afterVersion: 8,
      changeIds: ['new-insert', 'new-delete'],
      verified: true,
      trackChangesStateRestored: true,
    });
    expect(host.stateWrites).toEqual([
      { on_for: { 'user-1': true } },
      { on_for: { 'user-1': false } },
    ]);

    const submit = host.mainTransport.calls.find(call => call.name === 'applyOtUpdate');
    expect(submit?.args).toEqual([
      'doc-1',
      {
        doc: 'doc-1',
        op: [{ p: 6, i: 'new' }, { p: 9, d: 'old' }],
        v: 7,
        meta: { tc: expect.stringMatching(/^[a-f0-9]{18}$/) },
      },
    ]);
  });

  it('refuses a version changed between preparation and submission', async () => {
    const changedJoin = [
      ['alpha changed omega'],
      8,
      [],
      { changes: [] },
      'sharejs-text-ot',
    ];
    const host = new ServiceHost([beforeJoin, changedJoin]);

    await expect(new ChangesService(host).suggestTrackedChange({
      projectId: 'project-1',
      filePath: 'main.tex',
      oldText: 'old',
      newText: 'new',
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(host.stateWrites).toEqual([]);
  });

  it('preserves an existing per-user and guest tracking configuration', async () => {
    const priorState = {
      'user-1': false,
      'user-2': true,
      __guests__: true,
    };
    const host = new ServiceHost([beforeJoin, beforeJoin, afterJoin], priorState);

    const result = await new ChangesService(host).suggestTrackedChange({
      projectId: 'project-1',
      filePath: 'main.tex',
      oldText: 'old',
      newText: 'new',
    });

    expect(result.trackChangesStateRestored).toBe(true);
    expect(host.stateWrites).toEqual([
      {
        on_for: { 'user-1': true, 'user-2': true },
        on_for_guests: true,
      },
      {
        on_for: { 'user-1': false, 'user-2': true },
        on_for_guests: true,
      },
    ]);
    expect(host.state).toEqual(priorState);
  });

  it('accepts only explicit legacy IDs through the selected-ID endpoint', async () => {
    const host = new ServiceHost([
      pendingReplacementJoin,
      pendingReplacementJoin,
      acceptedReplacementJoin,
    ]);
    const result = await new ChangesService(host).resolveTrackedChanges({
      projectId: 'project-1',
      filePath: 'main.tex',
      changeIds: ['new-insert', 'new-delete'],
      action: 'accept',
      precondition: { expectedVersion: 8 },
    });

    expect(result).toMatchObject({
      action: 'accept',
      beforeVersion: 8,
      afterVersion: 9,
      verified: true,
      remainingChangeIds: [],
      transport: 'legacy-accept-endpoint',
    });
    expect(host.acceptedChanges).toEqual([{
      projectId: 'project-1',
      docId: 'doc-1',
      changeIds: ['new-insert', 'new-delete'],
    }]);
  });

  it('rejects a legacy replacement with reverse-position undo operations', async () => {
    const host = new ServiceHost([
      pendingReplacementJoin,
      pendingReplacementJoin,
      rejectedReplacementJoin,
    ]);
    const result = await new ChangesService(host).resolveTrackedChanges({
      projectId: 'project-1',
      filePath: 'main.tex',
      changeIds: ['new-insert', 'new-delete'],
      action: 'reject',
    });

    expect(result).toMatchObject({
      action: 'reject',
      verified: true,
      remainingChangeIds: [],
      transport: 'ot',
    });
    const submit = host.mainTransport.calls.find(call => call.name === 'applyOtUpdate');
    expect(submit?.args).toEqual([
      'doc-1',
      {
        doc: 'doc-1',
        op: [
          { p: 9, i: 'old', u: true },
          { p: 6, d: 'new', u: true },
        ],
        v: 8,
      },
    ]);
  });

  it('preserves an unselected legacy change while accepting one explicit ID', async () => {
    const afterOneAccepted = [
      ['alpha new omega'],
      9,
      [],
      {
        changes: [
          {
            id: 'new-delete',
            op: { p: 9, d: 'old' },
            metadata: { user_id: 'user-1', ts: '2026-07-13T00:00:00.000Z' },
          },
        ],
      },
      'sharejs-text-ot',
    ];
    const host = new ServiceHost([
      pendingReplacementJoin,
      pendingReplacementJoin,
      afterOneAccepted,
    ]);

    const result = await new ChangesService(host).resolveTrackedChanges({
      projectId: 'project-1',
      filePath: 'main.tex',
      changeIds: ['new-insert'],
      action: 'accept',
    });

    expect(result.remainingChangeIds).toEqual(['new-delete']);
    expect(result.verified).toBe(true);
  });

  it('rejects a history-OT replacement with snapshot operations', async () => {
    const host = new ServiceHost([
      pendingHistoryReplacementJoin,
      pendingHistoryReplacementJoin,
      rejectedHistoryReplacementJoin,
    ]);
    const result = await new ChangesService(host).resolveTrackedChanges({
      projectId: 'project-1',
      filePath: 'main.tex',
      changeIds: ['change-insert-6', 'change-delete-9'],
      action: 'reject',
      precondition: { expectedVersion: 8 },
    });

    expect(result).toMatchObject({
      otType: 'history-ot',
      action: 'reject',
      verified: true,
      remainingChangeIds: [],
    });
    const submit = host.mainTransport.calls.find(call => call.name === 'applyOtUpdate');
    expect(submit?.args).toEqual([
      'doc-1',
      {
        doc: 'doc-1',
        op: [{ textOperation: [
          6,
          -3,
          { r: 3, tracking: { type: 'none' } },
          6,
        ] }],
        v: 8,
      },
    ]);
  });

  it('rejects missing and duplicate change IDs before mutation', async () => {
    const missingHost = new ServiceHost([pendingReplacementJoin]);
    await expect(new ChangesService(missingHost).previewTrackedResolution({
      projectId: 'project-1',
      filePath: 'main.tex',
      changeIds: ['missing'],
      action: 'accept',
    })).rejects.toMatchObject({ code: 'CHANGE_NOT_FOUND' });

    const duplicateHost = new ServiceHost([pendingReplacementJoin]);
    await expect(new ChangesService(duplicateHost).previewTrackedResolution({
      projectId: 'project-1',
      filePath: 'main.tex',
      changeIds: ['new-insert', 'new-insert'],
      action: 'reject',
    })).rejects.toMatchObject({ code: 'AMBIGUOUS_CHANGE_ID' });
  });

  it('refuses a version changed after resolution preview preparation', async () => {
    const changedVersion = [
      pendingReplacementJoin[0],
      9,
      pendingReplacementJoin[2],
      pendingReplacementJoin[3],
      pendingReplacementJoin[4],
    ];
    const host = new ServiceHost([pendingReplacementJoin, changedVersion]);

    await expect(new ChangesService(host).resolveTrackedChanges({
      projectId: 'project-1',
      filePath: 'main.tex',
      changeIds: ['new-insert'],
      action: 'reject',
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(host.acceptedChanges).toEqual([]);
    expect(host.mainTransport.calls.filter(call => call.name === 'applyOtUpdate')).toEqual([]);
  });
});
