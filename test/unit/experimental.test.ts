import { describe, expect, it } from 'vitest';

import {
  isExperimentalReviewEnabled,
  requireExperimentalReview,
} from '../../src/experimental.js';

describe('experimental review feature gate', () => {
  it('requires an explicit true value', () => {
    expect(isExperimentalReviewEnabled(undefined)).toBe(false);
    expect(isExperimentalReviewEnabled('0')).toBe(false);
    expect(isExperimentalReviewEnabled('1')).toBe(true);
    expect(isExperimentalReviewEnabled('TRUE')).toBe(true);
  });

  it('returns a stable error when mutation is disabled', () => {
    expect(() => requireExperimentalReview(false, 'a test mutation'))
      .toThrowError(expect.objectContaining({ code: 'EXPERIMENTAL_FEATURE_DISABLED' }));
    expect(() => requireExperimentalReview(true, 'a test mutation')).not.toThrow();
  });
});
