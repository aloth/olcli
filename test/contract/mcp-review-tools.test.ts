import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerMcpReviewTools,
  type McpReviewClient,
} from '../../src/mcp/review-tools.js';
import type { McpReviewMode } from '../../src/mcp/review-policy.js';

const sourceSha256 = 'a'.repeat(64);
const expectedResultSha256 = 'b'.repeat(64);
const operationId = '11111111-1111-4111-8111-111111111111';

const preview = {
  projectId: 'project-1',
  docId: 'doc-1',
  path: 'main.tex',
  otType: 'sharejs-text-ot' as const,
  version: 7,
  textSha256: sourceSha256,
  position: 4,
  line: 1,
  column: 5,
  oldText: 'old',
  newText: 'new',
  operations: [
    { kind: 'delete' as const, position: 4, text: 'old' },
    { kind: 'insert' as const, position: 4, text: 'new' },
  ],
  expectedResultSha256,
};

function fakeClient() {
  return {
    inspectTrackedDocument: vi.fn(async () => ({
      projectId: 'project-1',
      docId: 'doc-1',
      path: 'main.tex',
      otType: 'sharejs-text-ot' as const,
      version: 7,
      textSha256: sourceSha256,
    })),
    previewTrackedSuggestion: vi.fn(async () => preview),
    suggestTrackedChange: vi.fn(async () => ({
      ...preview,
      beforeVersion: 7,
      afterVersion: 8,
      changeIds: ['change-1', 'change-2'],
      verified: true,
      trackChangesStateRestored: true,
    })),
    acceptTrackedChanges: vi.fn(async () => ({
      ...preview,
      action: 'accept' as const,
      changeIds: ['change-1'],
      changes: [{ id: 'change-1', kind: 'insert' as const, position: 4, text: 'new' }],
      transport: 'legacy-accept-endpoint' as const,
      beforeVersion: 8,
      afterVersion: 8,
      verified: true,
      remainingChangeIds: [],
    })),
    rejectTrackedChanges: vi.fn(async () => ({
      ...preview,
      action: 'reject' as const,
      changeIds: ['change-1'],
      changes: [{ id: 'change-1', kind: 'insert' as const, position: 4, text: 'new' }],
      transport: 'legacy-accept-endpoint' as const,
      beforeVersion: 8,
      afterVersion: 9,
      verified: true,
      remainingChangeIds: [],
    })),
    addressReviewComment: vi.fn(async input => input.dryRun ? ({
      operationId,
      threadId: 'thread-1',
      path: 'main.tex',
      relatedToComment: true,
      resolutionPolicy: input.resolutionPolicy || 'never',
      suggestion: preview,
    }) : ({
      operationId,
      resumed: false,
      entry: {
        operationId,
        threadId: 'thread-1',
        docId: 'doc-1',
        path: 'main.tex',
        sourceVersion: 7,
        sourceSha256,
        expectedResultSha256,
        requestSha256: 'c'.repeat(64),
        changeIds: ['change-1', 'change-2'],
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:01.000Z',
        state: 'suggested' as const,
        resolutionPolicy: input.resolutionPolicy || 'never',
        replySha256: 'd'.repeat(64),
        replyStatus: 'posted' as const,
      },
      suggestion: {
        ...preview,
        beforeVersion: 7,
        afterVersion: 8,
        changeIds: ['change-1', 'change-2'],
        verified: true,
        trackChangesStateRestored: true,
      },
    })),
    getReviewStatus: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projectId: 'project-1',
      entries: [],
    })),
    reconcileReview: vi.fn(async input => ({
      projectId: input.projectId,
      dryRun: input.dryRun === true,
      items: [],
    })),
  };
}

interface Harness {
  client: Client;
  server: McpServer;
  fake: ReturnType<typeof fakeClient>;
}

const harnesses: Harness[] = [];

async function harness(mode: McpReviewMode, experimentalReviewEnabled = true): Promise<Harness> {
  const fake = fakeClient();
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerMcpReviewTools(server, {
    mode,
    experimentalReviewEnabled,
    getClient: async () => fake as unknown as McpReviewClient,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const value = { client, server, fake };
  harnesses.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async item => {
    await item.client.close();
    await item.server.close();
  }));
});

async function callJson(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find(content => content.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Tool returned no text content');
  return { result, json: JSON.parse(text.text) as Record<string, any> };
}

const target = {
  project_id: 'project-1',
  file_path: 'main.tex',
  old_text: 'old',
  new_text: 'new',
};

const preconditions = {
  expected_version: 7,
  expected_text_sha256: sourceSha256,
};

describe('MCP review tool contracts', () => {
  it('registers preview-first tools with required mutation preconditions', async () => {
    const { client } = await harness('read');
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_mcp_review_policy',
      'inspect_tracked_document',
      'preview_tracked_change',
      'suggest_tracked_change',
      'accept_tracked_changes',
      'reject_tracked_changes',
      'address_review_comment',
      'review_status',
      'reconcile_review',
    ]));
    const suggest = tools.tools.find(tool => tool.name === 'suggest_tracked_change');
    expect(suggest?.inputSchema.required).toEqual(expect.arrayContaining([
      'project_id',
      'file_path',
      'old_text',
      'new_text',
      'expected_version',
      'expected_text_sha256',
    ]));
  });

  it('returns text-free document preconditions for resolution workflows', async () => {
    const { client, fake } = await harness('read');
    const outcome = await callJson(client, 'inspect_tracked_document', {
      project_id: 'project-1',
      file_path: 'main.tex',
    });
    expect(outcome.json).toEqual({
      projectId: 'project-1',
      docId: 'doc-1',
      path: 'main.tex',
      otType: 'sharejs-text-ot',
      version: 7,
      textSha256: sourceSha256,
    });
    expect(JSON.stringify(outcome.json)).not.toContain('old');
    expect(fake.inspectTrackedDocument).toHaveBeenCalledOnce();
  });

  it('allows previews in read mode and defaults mutation-shaped calls to dry-run', async () => {
    const { client, fake } = await harness('read');
    const outcome = await callJson(client, 'suggest_tracked_change', {
      ...target,
      ...preconditions,
    });

    expect(outcome.result.isError).not.toBe(true);
    expect(outcome.json.version).toBe(7);
    expect(fake.previewTrackedSuggestion).toHaveBeenCalledOnce();
    expect(fake.suggestTrackedChange).not.toHaveBeenCalled();
  });

  it('denies actual suggestions in read mode before creating a client', async () => {
    const { client, fake } = await harness('read');
    const outcome = await callJson(client, 'suggest_tracked_change', {
      ...target,
      ...preconditions,
      dry_run: false,
    });

    expect(outcome.result.isError).toBe(true);
    expect(outcome.json.error.code).toBe('MCP_REVIEW_POLICY_DENIED');
    expect(fake.suggestTrackedChange).not.toHaveBeenCalled();
    expect(fake.previewTrackedSuggestion).not.toHaveBeenCalled();
  });

  it('keeps experimental mutations disabled even in full mode until opted in', async () => {
    const { client, fake } = await harness('full', false);
    const policy = await callJson(client, 'get_mcp_review_policy', {});
    expect(policy.json).toMatchObject({
      mode: 'full',
      experimentalReviewEnabled: false,
      suggestTrackedChanges: false,
    });

    const outcome = await callJson(client, 'suggest_tracked_change', {
      ...target,
      ...preconditions,
      dry_run: false,
    });
    expect(outcome.json.error.code).toBe('EXPERIMENTAL_FEATURE_DISABLED');
    expect(fake.suggestTrackedChange).not.toHaveBeenCalled();
  });

  it('allows a preconditioned suggestion in suggest mode', async () => {
    const { client, fake } = await harness('suggest');
    const outcome = await callJson(client, 'suggest_tracked_change', {
      ...target,
      ...preconditions,
      dry_run: false,
    });

    expect(outcome.json).toMatchObject({ verified: true, trackChangesStateRestored: true });
    expect(fake.suggestTrackedChange).toHaveBeenCalledWith(expect.objectContaining({
      precondition: {
        expectedVersion: 7,
        expectedTextSha256: sourceSha256,
      },
      dryRun: false,
    }));
  });

  it('keeps accept and reject mutations exclusive to full mode', async () => {
    const suggestHarness = await harness('suggest');
    const denied = await callJson(suggestHarness.client, 'accept_tracked_changes', {
      project_id: 'project-1',
      file_path: 'main.tex',
      change_ids: ['change-1'],
      ...preconditions,
      dry_run: false,
    });
    expect(denied.json.error.code).toBe('MCP_REVIEW_POLICY_DENIED');
    expect(suggestHarness.fake.acceptTrackedChanges).not.toHaveBeenCalled();

    const fullHarness = await harness('full');
    const accepted = await callJson(fullHarness.client, 'accept_tracked_changes', {
      project_id: 'project-1',
      file_path: 'main.tex',
      change_ids: ['change-1'],
      ...preconditions,
      dry_run: false,
    });
    expect(accepted.json).toMatchObject({ action: 'accept', verified: true });
    expect(fullHarness.fake.acceptTrackedChanges).toHaveBeenCalledOnce();
  });

  it('allows comment-linked suggestions but not automatic resolution in suggest mode', async () => {
    const { client, fake } = await harness('suggest');
    const denied = await callJson(client, 'address_review_comment', {
      ...target,
      ...preconditions,
      thread_id: 'thread-1',
      operation_id: operationId,
      resolution_policy: 'after-suggest',
      dry_run: false,
    });
    expect(denied.json.error.code).toBe('MCP_REVIEW_POLICY_DENIED');
    expect(fake.addressReviewComment).not.toHaveBeenCalled();

    const allowed = await callJson(client, 'address_review_comment', {
      ...target,
      ...preconditions,
      thread_id: 'thread-1',
      operation_id: operationId,
      resolution_policy: 'never',
      dry_run: false,
    });
    expect(allowed.json).toMatchObject({ verified: true, trackChangesStateRestored: true });
    expect(fake.addressReviewComment).toHaveBeenCalledOnce();
  });

  it('allows dry-run reconciliation in read mode but gates ledger writes', async () => {
    const { client, fake } = await harness('read');
    const previewed = await callJson(client, 'reconcile_review', {
      project_id: 'project-1',
    });
    expect(previewed.json).toMatchObject({ dryRun: true, verified: true });
    expect(fake.reconcileReview).toHaveBeenCalledWith({
      projectId: 'project-1',
      operationIds: undefined,
      dryRun: true,
    });

    const denied = await callJson(client, 'reconcile_review', {
      project_id: 'project-1',
      dry_run: false,
    });
    expect(denied.json.error.code).toBe('MCP_REVIEW_POLICY_DENIED');
    expect(fake.reconcileReview).toHaveBeenCalledOnce();
  });
});
