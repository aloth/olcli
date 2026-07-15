import { describe, expect, it } from 'vitest';

import { sanitizeProtocolFixture } from '../../src/realtime/protocol-fixtures.js';

describe('sanitizeProtocolFixture', () => {
  it('marks fixtures and replaces identifiers, secrets, and supplied source text', () => {
    const fixture = sanitizeProtocolFixture({
      metadata: {
        schemaVersion: 1,
        capturedAt: '2026-07-13',
        instance: 'overleaf-cloud',
        operation: 'join-document',
        otType: 'history-ot',
        notes: 'Captured from 0123456789abcdef01234567',
      },
      exchange: {
        projectId: '0123456789abcdef01234567',
        cookie: 'overleaf_session2=secret',
        packet: 'source is PRIVATE SOURCE for 0123456789abcdef01234567',
      },
    }, { privateValues: ['PRIVATE SOURCE'] });

    expect(fixture.metadata.sanitized).toBe(true);
    expect(fixture.metadata.notes).toBe('Captured from 000000000000000000000001');
    expect(fixture.exchange).toEqual({
      projectId: '000000000000000000000001',
      cookie: '[REDACTED]',
      packet: 'source is [REDACTED_TEXT:14] for 000000000000000000000001',
    });
  });
});
