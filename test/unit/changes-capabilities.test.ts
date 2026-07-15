import { describe, expect, it } from 'vitest';

import { detectChangesCapabilities } from '../../src/changes/capabilities.js';
import { ProjectSession } from '../../src/realtime/project-session.js';
import type { RealtimeTransport } from '../../src/realtime/transport.js';
import type { JoinedDocument } from '../../src/realtime/types.js';

function makeSession(payload: unknown): ProjectSession {
  const transport: RealtimeTransport = {
    projectId: 'project-1',
    isOpen: true,
    joinProjectArgs: [payload],
    async open() {},
    async rpc() { return []; },
    async close() {},
  };
  return new ProjectSession(transport);
}

const document: JoinedDocument = {
  docId: 'doc-1',
  content: 'text',
  lines: ['text'],
  version: 1,
  type: 'sharejs-text-ot',
  ranges: {},
};

describe('tracked-change capability detection', () => {
  it('recognizes an owner with per-user tracking enabled', () => {
    const session = makeSession({
      permissionsLevel: 'owner',
      project: {
        features: { trackChanges: true, trackChangesVisible: true },
        trackChangesState: { 'user-1': true, __guests__: false },
      },
    });

    expect(detectChangesCapabilities(session, document, 'main.tex', 'user-1'))
      .toMatchObject({
        permissionsLevel: 'owner',
        canWrite: true,
        canTrackedWrite: true,
        featureAvailable: true,
        trackChangesStateReadable: true,
        trackChangesEnabledForCurrentUser: true,
        canList: true,
        canSuggest: true,
        canAccept: true,
        canReject: true,
      });
    expect(detectChangesCapabilities(session, document, 'main.tex', 'user-1').reasons)
      .toEqual([]);
  });

  it('keeps listing available while mutations fail closed', () => {
    const session = makeSession({
      permissionsLevel: 'readOnly',
      project: { features: { trackChanges: false } },
    });

    const capabilities = detectChangesCapabilities(session, document, 'main.tex');
    expect(capabilities).toMatchObject({
      canWrite: false,
      canTrackedWrite: false,
      featureAvailable: false,
      trackChangesStateReadable: false,
      canList: true,
      canSuggest: false,
      canAccept: false,
      canReject: false,
    });
    expect(capabilities.reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/does not advertise/),
      expect.stringMatching(/state is unavailable/),
      expect.stringMatching(/permission level/),
      expect.stringMatching(/user ID/),
    ]));
  });
});
