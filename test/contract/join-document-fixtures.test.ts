import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { normalizeJoinedDocument } from '../../src/realtime/document-normalizer.js';

interface JoinFixture {
  metadata: { sanitized: boolean; otType: 'sharejs-text-ot' | 'history-ot' };
  exchange: { docId: string; acknowledgementArgs: unknown[] };
}

function loadFixture(name: string): JoinFixture {
  const path = fileURLToPath(new URL(`../fixtures/protocol/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as JoinFixture;
}

describe('sanitized join-document fixtures', () => {
  it.each([
    ['join-sharejs-text.json', 'sharejs-text-ot', 7],
    ['join-history-ot.json', 'history-ot', 11],
  ] as const)('normalizes %s', (fixtureName, otType, version) => {
    const fixture = loadFixture(fixtureName);
    expect(fixture.metadata).toMatchObject({ sanitized: true, otType });

    const snapshot = normalizeJoinedDocument(
      fixture.exchange.docId,
      fixture.exchange.acknowledgementArgs
    );
    expect(snapshot).toMatchObject({
      docId: '000000000000000000000001',
      type: otType,
      version,
    });
    expect(snapshot.ranges.comments).toHaveLength(1);
  });
});
