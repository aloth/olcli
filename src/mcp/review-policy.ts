import { OlcliError } from '../errors/olcli-error.js';

export type McpReviewMode = 'read' | 'suggest' | 'full';
export type McpReviewPermission = 'suggest' | 'full';

const modes: McpReviewMode[] = ['read', 'suggest', 'full'];

export function parseMcpReviewMode(value: string | undefined): McpReviewMode {
  const normalized = (value || 'read').trim().toLowerCase();
  if (modes.includes(normalized as McpReviewMode)) {
    return normalized as McpReviewMode;
  }
  throw new OlcliError(
    'MCP_REVIEW_MODE_INVALID',
    'OLCLI_MCP_REVIEW_MODE must be read, suggest, or full.',
    { details: { configuredValue: normalized } }
  );
}

export function requireMcpReviewPermission(
  mode: McpReviewMode,
  required: McpReviewPermission,
  action: string
): void {
  const rank: Record<McpReviewMode, number> = { read: 0, suggest: 1, full: 2 };
  if (rank[mode] >= rank[required]) return;
  throw new OlcliError(
    'MCP_REVIEW_POLICY_DENIED',
    `MCP review mode '${mode}' does not permit ${action}.`,
    { details: { mode, requiredMode: required, action } }
  );
}

export function describeMcpReviewPolicy(
  mode: McpReviewMode,
  experimentalReviewEnabled: boolean
) {
  return {
    mode,
    experimentalReviewEnabled,
    read: true,
    preview: true,
    suggestTrackedChanges: experimentalReviewEnabled
      && (mode === 'suggest' || mode === 'full'),
    replyToComments: mode === 'suggest' || mode === 'full',
    acceptOrRejectTrackedChanges: experimentalReviewEnabled && mode === 'full',
    resolveComments: mode === 'full',
    generalProjectMutation: mode === 'full',
  };
}
