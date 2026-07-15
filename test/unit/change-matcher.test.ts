import { describe, expect, it } from 'vitest';

import {
  lineColumnToPosition,
  resolveTextMatchPosition,
  sha256Text,
} from '../../src/changes/matcher.js';
import { generateTrackChangeSeed } from '../../src/changes/track-change-seed.js';

describe('targeted change matching', () => {
  it('requires uniqueness unless occurrence is explicit', () => {
    expect(() => resolveTextMatchPosition('old x old', {
      oldText: 'old',
      newText: 'new',
    })).toThrow(expect.objectContaining({ code: 'AMBIGUOUS_MATCH' }));

    expect(resolveTextMatchPosition('old x old', {
      oldText: 'old',
      newText: 'new',
      occurrence: 2,
    })).toBe(6);
  });

  it('supports explicit offsets and one-based line/column positions', () => {
    expect(lineColumnToPosition('first\nsecond', 2, 3)).toBe(8);
    expect(resolveTextMatchPosition('first\nsecond', {
      oldText: 'cond',
      newText: 'lected',
      line: 2,
      column: 3,
    })).toBe(8);
    expect(resolveTextMatchPosition('abc', {
      oldText: '',
      newText: '!',
      position: 3,
    })).toBe(3);
  });

  it('fails when explicit source text does not match', () => {
    expect(() => resolveTextMatchPosition('abc', {
      oldText: 'xyz',
      newText: 'new',
      position: 0,
    })).toThrow(expect.objectContaining({ code: 'SOURCE_MISMATCH' }));
  });

  it('hashes UTF-8 source and generates an ObjectId-compatible seed', () => {
    expect(sha256Text('café')).toMatch(/^[a-f0-9]{64}$/);
    expect(generateTrackChangeSeed(new Date('2026-07-13T00:00:00.000Z')))
      .toMatch(/^[a-f0-9]{18}$/);
  });
});
