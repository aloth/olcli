export type OverleafOtType =
  | 'sharejs-text-ot'
  | 'history-ot'
  | `unknown:${string}`;

export interface ProjectSocketSession {
  sid: string;
  projectId: string;
  pollUrl: () => string;
}

export interface JoinedDocument {
  docId: string;
  lines: string[];
  content: string;
  version: number;
  ranges: any;
  type: OverleafOtType;
}

export interface SocketIoV09Event {
  name: string;
  args: unknown[];
}
