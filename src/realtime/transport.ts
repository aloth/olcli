export interface RealtimeTransport {
  readonly projectId: string;
  readonly isOpen: boolean;
  readonly joinProjectArgs: readonly unknown[] | undefined;

  open(): Promise<void>;
  rpc(name: string, args: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}
