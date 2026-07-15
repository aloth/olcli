import { describe, expect, it } from 'vitest';

import { OlcliError } from '../../src/errors/olcli-error.js';
import { serializeError } from '../../src/errors/serialize-error.js';

describe('serializeError', () => {
  it('preserves stable olcli error codes and safe details', () => {
    const error = new OlcliError('VERSION_CONFLICT', 'Document version changed', {
      details: { expectedVersion: 4, actualVersion: 5 },
    });

    expect(serializeError(error)).toEqual({
      name: 'OlcliError',
      message: 'Document version changed',
      code: 'VERSION_CONFLICT',
      details: { expectedVersion: 4, actualVersion: 5 },
    });
  });
});
