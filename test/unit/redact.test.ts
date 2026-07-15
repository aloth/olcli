import { describe, expect, it } from 'vitest';

import { Logger } from '../../src/logging/logger.js';
import { redactString, redactValue } from '../../src/logging/redact.js';

describe('redactValue', () => {
  it('masks credentials, emails, and document text without mutating input', () => {
    const input = {
      headers: {
        Cookie: 'overleaf_session2=super-secret; theme=dark',
        Authorization: 'Bearer abc.def.ghi',
        'X-Csrf-Token': 'csrf-secret',
      },
      email: 'author@example.com',
      csrfToken: 'another-secret',
      loginPassword: 'password-secret',
      content: 'private manuscript text',
      status: 200,
    };

    expect(redactValue(input)).toEqual({
      headers: {
        Cookie: '[REDACTED]',
        Authorization: '[REDACTED]',
        'X-Csrf-Token': '[REDACTED]',
      },
      email: '[REDACTED_EMAIL]',
      csrfToken: '[REDACTED]',
      loginPassword: '[REDACTED]',
      content: '[REDACTED_TEXT:23]',
      status: 200,
    });
    expect(input.content).toBe('private manuscript text');
  });

  it('masks secrets embedded in diagnostic strings', () => {
    expect(redactString(
      'Cookie overleaf_session2=secret; Authorization: Bearer abc123 user@example.com'
    )).toBe(
      'Cookie overleaf_session2=[REDACTED]; Authorization: Bearer [REDACTED] [REDACTED_EMAIL]'
    );
    expect(redactString('{"csrfToken":"csrf-secret","password":"password-secret"}'))
      .not.toContain('csrf-secret');
  });
});

describe('Logger', () => {
  it('keeps protocol frames disabled until the unsafe flag is explicit', () => {
    const lines: string[] = [];
    const logger = new Logger({ enabled: true, sink: line => lines.push(line) });

    logger.protocol('receive', '5:::{"name":"joinDoc"}');
    expect(lines).toEqual([]);

    logger.setUnsafeProtocolFrames(true);
    logger.protocol('receive', 'Cookie: overleaf_session2=secret');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret');
  });
});
