import { describe, expect, it } from 'vitest';

import {
  describeMcpReviewPolicy,
  parseMcpReviewMode,
  requireMcpReviewPermission,
} from '../../src/mcp/review-policy.js';

describe('MCP review policy', () => {
  it('defaults to read and parses explicit modes', () => {
    expect(parseMcpReviewMode(undefined)).toBe('read');
    expect(parseMcpReviewMode(' SUGGEST ')).toBe('suggest');
    expect(parseMcpReviewMode('full')).toBe('full');
  });

  it('fails closed for invalid configuration', () => {
    expect(() => parseMcpReviewMode('write')).toThrowError(
      expect.objectContaining({ code: 'MCP_REVIEW_MODE_INVALID' })
    );
  });

  it('enforces the mode hierarchy with stable errors', () => {
    expect(() => requireMcpReviewPermission('read', 'suggest', 'a suggestion'))
      .toThrowError(expect.objectContaining({ code: 'MCP_REVIEW_POLICY_DENIED' }));
    expect(() => requireMcpReviewPermission('suggest', 'full', 'acceptance'))
      .toThrowError(expect.objectContaining({ code: 'MCP_REVIEW_POLICY_DENIED' }));
    expect(() => requireMcpReviewPermission('full', 'suggest', 'a suggestion'))
      .not.toThrow();
  });

  it('describes effective least-privilege capabilities', () => {
    expect(describeMcpReviewPolicy('suggest', true)).toEqual({
      mode: 'suggest',
      experimentalReviewEnabled: true,
      read: true,
      preview: true,
      suggestTrackedChanges: true,
      replyToComments: true,
      acceptOrRejectTrackedChanges: false,
      resolveComments: false,
      generalProjectMutation: false,
    });
    expect(describeMcpReviewPolicy('full', false)).toMatchObject({
      suggestTrackedChanges: false,
      acceptOrRejectTrackedChanges: false,
    });
  });
});
