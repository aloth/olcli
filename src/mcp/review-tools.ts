import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';

import type { OverleafClient } from '../client.js';
import { requireExperimentalReview } from '../experimental.js';
import { serializeError } from '../errors/serialize-error.js';
import {
  describeMcpReviewPolicy,
  requireMcpReviewPermission,
  type McpReviewMode,
} from './review-policy.js';

export type McpReviewClient = Pick<
  OverleafClient,
  | 'previewTrackedSuggestion'
  | 'inspectTrackedDocument'
  | 'suggestTrackedChange'
  | 'acceptTrackedChanges'
  | 'rejectTrackedChanges'
  | 'addressReviewComment'
  | 'getReviewStatus'
  | 'reconcileReview'
>;

export interface RegisterMcpReviewToolsOptions {
  mode: McpReviewMode;
  experimentalReviewEnabled: boolean;
  getClient: () => Promise<McpReviewClient>;
}

function wrapReviewTool<T>(
  fn: () => Promise<T>
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  return fn().then(
    result => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    }),
    (error: unknown) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: serializeError(error) }, null, 2),
      }],
      isError: true,
    })
  );
}

const projectId = z.string().min(1).describe('The Overleaf project ID');
const filePath = z.string().min(1).describe('Path of the document within the project');
const expectedVersion = z.number().int().nonnegative()
  .describe('Document OT version returned by a fresh preview');
const expectedTextSha256 = z.string().regex(/^[a-f0-9]{64}$/)
  .describe('Source SHA-256 returned by a fresh preview');
const dryRun = z.boolean().optional().default(true)
  .describe('Preview only by default; set false to request a policy-gated mutation');

const targetFields = {
  old_text: z.string().describe('Exact existing source text; empty only for insertion'),
  new_text: z.string().describe('Proposed replacement text; empty only for deletion'),
  occurrence: z.number().int().positive().optional()
    .describe('One-based occurrence when the old text is not unique'),
  position: z.number().int().nonnegative().optional()
    .describe('Zero-based source offset; required when old_text is empty'),
  line: z.number().int().positive().optional().describe('One-based line number'),
  column: z.number().int().positive().optional().describe('One-based column number'),
};

export function registerMcpReviewTools(
  server: McpServer,
  options: RegisterMcpReviewToolsOptions
): void {
  const { mode, experimentalReviewEnabled, getClient } = options;

  server.tool(
    'get_mcp_review_policy',
    'Show the effective OLCLI_MCP_REVIEW_MODE and permitted review actions.',
    async () => wrapReviewTool(async () => describeMcpReviewPolicy(
      mode,
      experimentalReviewEnabled
    ))
  );

  server.tool(
    'preview_tracked_change',
    'Preview one targeted native tracked replacement. This tool never mutates Overleaf.',
    {
      project_id: projectId,
      file_path: filePath,
      ...targetFields,
    },
    async ({
      project_id,
      file_path,
      old_text,
      new_text,
      occurrence,
      position,
      line,
      column,
    }) => wrapReviewTool(async () => {
      const client = await getClient();
      return client.previewTrackedSuggestion({
        projectId: project_id,
        filePath: file_path,
        oldText: old_text,
        newText: new_text,
        occurrence,
        position,
        line,
        column,
      });
    })
  );

  server.tool(
    'inspect_tracked_document',
    'Return text-free document identity, OT type, version, and source SHA-256 for mutation preconditions. This tool is read-only.',
    {
      project_id: projectId,
      file_path: filePath,
    },
    async ({ project_id, file_path }) => wrapReviewTool(async () => {
      const client = await getClient();
      return client.inspectTrackedDocument(project_id, file_path);
    })
  );

  server.tool(
    'suggest_tracked_change',
    'Preview or submit one targeted native tracked replacement. Mutation requires suggest or full mode plus fresh version and source-hash preconditions.',
    {
      project_id: projectId,
      file_path: filePath,
      ...targetFields,
      expected_version: expectedVersion,
      expected_text_sha256: expectedTextSha256,
      dry_run: dryRun,
    },
    async ({
      project_id,
      file_path,
      old_text,
      new_text,
      occurrence,
      position,
      line,
      column,
      expected_version,
      expected_text_sha256,
      dry_run,
    }) => wrapReviewTool(async () => {
      const input = {
        projectId: project_id,
        filePath: file_path,
        oldText: old_text,
        newText: new_text,
        occurrence,
        position,
        line,
        column,
        precondition: {
          expectedVersion: expected_version,
          expectedTextSha256: expected_text_sha256,
        },
      };
      if (!dry_run) {
        requireMcpReviewPermission(mode, 'suggest', 'tracked-change suggestions');
        requireExperimentalReview(experimentalReviewEnabled, 'tracked-change suggestions');
      }
      const client = await getClient();
      if (dry_run) return client.previewTrackedSuggestion(input);
      return client.suggestTrackedChange({ ...input, dryRun: false });
    })
  );

  const registerResolutionTool = (action: 'accept' | 'reject') => {
    server.tool(
      `${action}_tracked_changes`,
      `Preview or ${action} explicit native tracked-change IDs. Mutation requires full mode and fresh version and source-hash preconditions.`,
      {
        project_id: projectId,
        file_path: filePath,
        change_ids: z.array(z.string().min(1)).min(1)
          .describe(`Explicit tracked-change IDs to ${action}`),
        expected_version: expectedVersion,
        expected_text_sha256: expectedTextSha256,
        dry_run: dryRun,
      },
      async ({
        project_id,
        file_path,
        change_ids,
        expected_version,
        expected_text_sha256,
        dry_run,
      }) => wrapReviewTool(async () => {
        if (!dry_run) {
          requireMcpReviewPermission(mode, 'full', `${action}ing tracked changes`);
          requireExperimentalReview(
            experimentalReviewEnabled,
            `${action}ing tracked changes`
          );
        }
        const client = await getClient();
        const input = {
          projectId: project_id,
          filePath: file_path,
          changeIds: change_ids,
          precondition: {
            expectedVersion: expected_version,
            expectedTextSha256: expected_text_sha256,
          },
          dryRun: dry_run,
        };
        return action === 'accept'
          ? client.acceptTrackedChanges(input)
          : client.rejectTrackedChanges(input);
      })
    );
  };

  registerResolutionTool('accept');
  registerResolutionTool('reject');

  server.tool(
    'address_review_comment',
    'Preview or create a tracked suggestion linked to one comment. The safe default leaves the comment open. Mutation requires suggest or full mode; comment resolution requires full mode.',
    {
      project_id: projectId,
      thread_id: z.string().min(1).describe('Comment thread ID'),
      file_path: filePath,
      ...targetFields,
      expected_version: expectedVersion,
      expected_text_sha256: expectedTextSha256,
      operation_id: z.string().uuid()
        .describe('Stable UUID used for safe retries and ledger reconciliation'),
      reply: z.string().min(1).optional().describe('Reply posted after a verified suggestion'),
      resolution_policy: z.enum(['never', 'after-suggest', 'after-accept'])
        .optional()
        .default('never'),
      allow_unrelated: z.boolean().optional().default(false),
      dry_run: dryRun,
    },
    async ({
      project_id,
      thread_id,
      file_path,
      old_text,
      new_text,
      occurrence,
      position,
      line,
      column,
      expected_version,
      expected_text_sha256,
      operation_id,
      reply,
      resolution_policy,
      allow_unrelated,
      dry_run,
    }) => wrapReviewTool(async () => {
      if (!dry_run) {
        requireMcpReviewPermission(mode, 'suggest', 'comment-linked tracked suggestions');
        requireExperimentalReview(
          experimentalReviewEnabled,
          'comment-linked tracked suggestions'
        );
        if (resolution_policy !== 'never') {
          requireMcpReviewPermission(mode, 'full', 'automatic comment resolution');
        }
      }
      const client = await getClient();
      const result = await client.addressReviewComment({
        projectId: project_id,
        threadId: thread_id,
        filePath: file_path,
        oldText: old_text,
        newText: new_text,
        occurrence,
        position,
        line,
        column,
        precondition: {
          expectedVersion: expected_version,
          expectedTextSha256: expected_text_sha256,
        },
        reply,
        resolutionPolicy: resolution_policy,
        operationId: operation_id,
        allowUnrelated: allow_unrelated,
        dryRun: dry_run,
      });
      if (dry_run || !('entry' in result)) return result;
      return {
        ...result,
        verified: result.suggestion?.verified
          ?? (result.entry.changeIds.length > 0 && result.entry.state !== 'unknown'),
        trackChangesStateRestored: result.suggestion?.trackChangesStateRestored,
      };
    })
  );

  server.tool(
    'review_status',
    'Read the local text-free review ledger. This tool does not mutate Overleaf.',
    { project_id: projectId },
    async ({ project_id }) => wrapReviewTool(async () => {
      const client = await getClient();
      return client.getReviewStatus({ projectId: project_id });
    })
  );

  server.tool(
    'reconcile_review',
    'Preview or reconcile ledger entries against native changes and comments. Writes and automatic resolution require full mode.',
    {
      project_id: projectId,
      operation_ids: z.array(z.string().uuid()).min(1).optional(),
      dry_run: dryRun,
    },
    async ({ project_id, operation_ids, dry_run }) => wrapReviewTool(async () => {
      if (!dry_run) {
        requireMcpReviewPermission(mode, 'full', 'review reconciliation writes');
        requireExperimentalReview(experimentalReviewEnabled, 'review reconciliation writes');
      }
      const client = await getClient();
      const result = await client.reconcileReview({
        projectId: project_id,
        operationIds: operation_ids,
        dryRun: dry_run,
      });
      return {
        ...result,
        verified: result.items.every(item => item.state !== 'unknown'),
      };
    })
  );
}
