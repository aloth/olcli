import type { ProjectSession } from '../realtime/project-session.js';
import type { JoinedDocument } from '../realtime/types.js';
import type {
  ChangesCapabilities,
  OverleafPermissionsLevel,
  TrackChangesState,
} from './types.js';

function normalizePermissionsLevel(value: unknown): OverleafPermissionsLevel {
  if (
    value === 'owner'
    || value === 'readAndWrite'
    || value === 'review'
    || value === 'readOnly'
  ) return value;
  return `unknown:${String(value)}`;
}

export function normalizeTrackChangesState(value: unknown): TrackChangesState | undefined {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const state: Record<string, boolean> = {};
  for (const [userId, enabled] of Object.entries(value)) {
    if (typeof enabled !== 'boolean') return undefined;
    state[userId] = enabled;
  }
  return state;
}

export function readTrackChangesProjectState(session: ProjectSession): {
  present: boolean;
  state?: TrackChangesState;
} {
  const project = (session.joinProjectArgs?.[0] as {
    project?: { trackChangesState?: unknown };
  } | undefined)?.project;
  const present = Boolean(
    project && Object.prototype.hasOwnProperty.call(project, 'trackChangesState')
  );
  return {
    present,
    state: normalizeTrackChangesState(project?.trackChangesState),
  };
}

function enabledForCurrentUser(
  state: TrackChangesState | undefined,
  currentUserId?: string
): boolean | undefined {
  if (state === undefined) return undefined;
  if (typeof state === 'boolean') return state;
  if (currentUserId) return state[currentUserId] === true;
  return state.__guests__ === true;
}

export function detectChangesCapabilities(
  session: ProjectSession,
  document: JoinedDocument,
  path: string,
  currentUserId?: string
): ChangesCapabilities {
  const payload = session.joinProjectArgs?.[0] as {
    permissionsLevel?: unknown;
    project?: {
      features?: { trackChanges?: unknown; trackChangesVisible?: unknown };
      trackChangesState?: unknown;
    };
  } | undefined;
  const project = payload?.project;
  const permissionsLevel = normalizePermissionsLevel(payload?.permissionsLevel);
  const canWrite = permissionsLevel === 'owner' || permissionsLevel === 'readAndWrite';
  const canTrackedWrite = canWrite || permissionsLevel === 'review';
  const featureAvailable = project?.features?.trackChanges === true
    && project?.features?.trackChangesVisible !== false;
  const { present: hasTrackChangesState, state: trackChangesState } = readTrackChangesProjectState(session);
  const trackChangesStateReadable = hasTrackChangesState && trackChangesState !== undefined;
  const supportedOtType = document.type === 'sharejs-text-ot' || document.type === 'history-ot';
  const canList = supportedOtType;
  const canSuggest = supportedOtType
    && featureAvailable
    && canTrackedWrite
    && Boolean(currentUserId);
  const canResolve = supportedOtType && canTrackedWrite;
  const reasons: string[] = [];

  if (!supportedOtType) reasons.push(`Unsupported document OT type: ${document.type}`);
  if (!featureAvailable) reasons.push('The project does not advertise the tracked-changes feature.');
  if (!trackChangesStateReadable) reasons.push('The complete tracked-changes state is unavailable or malformed.');
  if (!canTrackedWrite) reasons.push('The current project permission level cannot create tracked edits.');
  if (!currentUserId) reasons.push('The authenticated Overleaf user ID could not be determined.');
  if (document.type === 'history-ot') {
    reasons.push('history-ot writes are protocol-contract tested but still require live validation on a disposable history-ot project.');
  }

  return {
    projectId: session.projectId,
    docId: document.docId,
    path,
    permissionsLevel,
    canWrite,
    canTrackedWrite,
    featureAvailable,
    trackChangesStateReadable,
    trackChangesState,
    trackChangesEnabledForCurrentUser: enabledForCurrentUser(trackChangesState, currentUserId),
    currentUserId,
    otType: document.type,
    canList,
    canSuggest,
    canAccept: canResolve,
    canReject: canResolve,
    reasons,
  };
}
