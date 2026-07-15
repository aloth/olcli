import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseSocketIoV09Ack,
  parseSocketIoV09Event,
} from '../../src/realtime/socketio-v09-framing.js';

interface AckFixture {
  metadata: { schemaVersion: number; sanitized: boolean };
  exchange: { sent: string; received: string };
}

describe('sanitized Socket.IO acknowledgement fixture', () => {
  it('replays the committed event and acknowledgement shapes', () => {
    const fixturePath = fileURLToPath(
      new URL('../fixtures/protocol/socketio-ack.json', import.meta.url)
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as AckFixture;

    expect(fixture.metadata).toMatchObject({ schemaVersion: 1, sanitized: true });
    expect(fixture.exchange.sent).toContain('joinDoc');
    expect(parseSocketIoV09Ack(fixture.exchange.received, 42))
      .toEqual([null, ['[REDACTED_TEXT:12]'], 7]);
    expect(parseSocketIoV09Event('5:::{"name":"ready","args":[]}'))
      .toEqual({ name: 'ready', args: [] });
  });
});
