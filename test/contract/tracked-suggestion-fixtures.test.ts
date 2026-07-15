import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getTrackedChangesAdapter } from '../../src/changes/adapters.js';
import type {
  AdapterMutation,
  BuildTrackedReplacementOptions,
} from '../../src/changes/types.js';
import type { JoinedDocument, OverleafOtType } from '../../src/realtime/types.js';

interface SuggestionFixture {
  metadata: { sanitized: boolean; otType: OverleafOtType };
  exchange: {
    document: JoinedDocument;
    input: { position: number; oldText: string; newText: string };
    options: Omit<BuildTrackedReplacementOptions, 'timestamp'> & { timestamp: string };
    expectedMutation: AdapterMutation;
  };
}

function loadFixture(name: string): SuggestionFixture {
  const path = fileURLToPath(new URL(`../fixtures/protocol/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as SuggestionFixture;
}

describe('sanitized tracked-suggestion fixtures', () => {
  it.each([
    'suggest-sharejs-text.json',
    'suggest-history-ot.json',
  ])('replays %s', fixtureName => {
    const fixture = loadFixture(fixtureName);
    const { document, input, options, expectedMutation } = fixture.exchange;
    expect(fixture.metadata.sanitized).toBe(true);
    expect(document.type).toBe(fixture.metadata.otType);

    const mutation = getTrackedChangesAdapter(document.type).buildTrackedReplacement(
      document,
      input.position,
      input.oldText,
      input.newText,
      { ...options, timestamp: new Date(options.timestamp) }
    );
    expect(mutation).toEqual(expectedMutation);
  });
});
