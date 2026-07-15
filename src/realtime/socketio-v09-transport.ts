import { OlcliError } from '../errors/olcli-error.js';
import {
  decodeSocketIoV09Payload,
  encodeSocketIoV09Event,
  parseSocketIoV09Ack,
  parseSocketIoV09Event,
} from './socketio-v09-framing.js';
import type { RealtimeTransport } from './transport.js';

export interface SocketHttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  expect?: 'text';
}

export interface SocketHttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string | string[]>;
  body: unknown;
}

export type SocketHttpRequester = (
  url: string,
  options: SocketHttpRequestOptions
) => Promise<SocketHttpResponse>;

export interface SocketIoV09TransportOptions {
  baseUrl: string;
  projectId: string;
  request: SocketHttpRequester;
  headers: () => Record<string, string>;
  applyResponseCookies?: (headers: Record<string, string | string[]>) => void;
  onProtocolFrame?: (direction: 'send' | 'receive', frame: string) => void;
  handshakePollAttempts?: number;
  acknowledgementPollAttempts?: number;
  nextRequestId?: () => number;
  now?: () => number;
}

/** Socket.IO 0.9 XHR-polling transport used by Overleaf's collaboration API. */
export class SocketIoV09Transport implements RealtimeTransport {
  readonly projectId: string;

  private readonly options: SocketIoV09TransportOptions;
  private sid?: string;
  private pollUrl?: () => string;
  private opened = false;
  private closed = false;
  private nextId = 1;
  private queuedPackets: string[] = [];
  private _joinProjectArgs?: unknown[];

  constructor(options: SocketIoV09TransportOptions) {
    this.options = options;
    this.projectId = options.projectId;
  }

  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  get joinProjectArgs(): readonly unknown[] | undefined {
    return this._joinProjectArgs;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    if (this.closed) {
      throw new OlcliError('PROTOCOL_ERROR', 'A closed project transport cannot be reopened');
    }

    const now = this.options.now ?? Date.now;
    const handshakeUrl = `${this.options.baseUrl}/socket.io/1/?projectId=${encodeURIComponent(this.projectId)}&t=${now()}`;

    try {
      const response = await this.request(handshakeUrl, {
        headers: this.options.headers(),
        expect: 'text',
        timeoutMs: 5000,
      });
      this.applyResponseCookies(response.headers);
      if (!response.ok) {
        throw new OlcliError(
          'SOCKET_HANDSHAKE_FAILED',
          `Failed to open project socket: HTTP ${response.status}`
        );
      }

      const sid = String(response.body ?? '').trim().split(':')[0];
      if (!sid) {
        throw new OlcliError('SOCKET_HANDSHAKE_FAILED', 'Project socket handshake returned no session id');
      }

      this.sid = sid;
      this.pollUrl = () => `${this.options.baseUrl}/socket.io/1/xhr-polling/${sid}?projectId=${encodeURIComponent(this.projectId)}&t=${now()}`;

      const attempts = this.options.handshakePollAttempts ?? 8;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const packets = await this.poll();
        for (let packetIndex = 0; packetIndex < packets.length; packetIndex += 1) {
          const packet = packets[packetIndex];
          const event = parseSocketIoV09Event(packet);
          if (event?.name === 'joinProjectResponse') {
            this._joinProjectArgs = event.args;
            this.queuedPackets.push(...packets.slice(packetIndex + 1));
            this.opened = true;
            return;
          }
          this.queuedPackets.push(packet);
        }
      }

      throw new OlcliError(
        'SOCKET_HANDSHAKE_FAILED',
        'Project socket did not return joinProjectResponse'
      );
    } catch (error) {
      await this.close();
      if (error instanceof OlcliError) throw error;
      throw new OlcliError('SOCKET_HANDSHAKE_FAILED', 'Failed to open project socket', { cause: error });
    }
  }

  async rpc(name: string, args: unknown[]): Promise<unknown[]> {
    if (!this.isOpen) {
      throw new OlcliError('PROTOCOL_ERROR', 'Project transport is not open');
    }

    const id = this.options.nextRequestId?.() ?? this.nextId++;
    await this.postPacket(encodeSocketIoV09Event(id, name, args));

    const attempts = this.options.acknowledgementPollAttempts ?? 10;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const queued = this.takeAcknowledgement(id);
      if (queued) return this.unwrapAcknowledgement(name, queued);

      const packets = await this.poll();
      this.queuedPackets.push(...packets);
      const acknowledgement = this.takeAcknowledgement(id);
      if (acknowledgement) return this.unwrapAcknowledgement(name, acknowledgement);
    }

    throw new OlcliError('SOCKET_TIMEOUT', `${name} did not return an acknowledgement`, {
      details: { operation: name },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.sid || !this.pollUrl) return;

    try {
      await this.postPacket('0::', true);
    } catch {
      // Cleanup is best effort. The original operation error remains primary.
    } finally {
      this.opened = false;
      this.queuedPackets = [];
    }
  }

  private async poll(): Promise<string[]> {
    if (!this.pollUrl) {
      throw new OlcliError('PROTOCOL_ERROR', 'Project transport has no polling URL');
    }
    const response = await this.request(this.pollUrl(), {
      headers: this.options.headers(),
      expect: 'text',
      timeoutMs: 7000,
    });
    this.applyResponseCookies(response.headers);
    if (!response.ok) {
      throw new OlcliError('PROTOCOL_ERROR', `Socket poll failed: HTTP ${response.status}`);
    }

    let packets: string[];
    try {
      packets = decodeSocketIoV09Payload(String(response.body ?? ''));
    } catch (error) {
      throw new OlcliError('PROTOCOL_ERROR', 'Socket poll returned malformed framing', { cause: error });
    }

    for (const packet of packets) {
      this.options.onProtocolFrame?.('receive', packet);
      if (packet.startsWith('2::')) await this.postPacket('2::');
    }
    return packets;
  }

  private async postPacket(packet: string, allowClosed = false): Promise<void> {
    if (!this.pollUrl || (this.closed && !allowClosed)) {
      throw new OlcliError('PROTOCOL_ERROR', 'Project transport is not available');
    }
    this.options.onProtocolFrame?.('send', packet);
    const response = await this.request(this.pollUrl(), {
      method: 'POST',
      headers: {
        ...this.options.headers(),
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: packet,
      expect: 'text',
      timeoutMs: 5000,
    });
    this.applyResponseCookies(response.headers);
    if (!response.ok) {
      throw new OlcliError('PROTOCOL_ERROR', `Socket post failed: HTTP ${response.status}`);
    }
  }

  private takeAcknowledgement(id: number): unknown[] | null {
    for (let index = 0; index < this.queuedPackets.length; index += 1) {
      let acknowledgement: unknown[] | null;
      try {
        acknowledgement = parseSocketIoV09Ack(this.queuedPackets[index], id);
      } catch (error) {
        throw new OlcliError('PROTOCOL_ERROR', 'Socket returned a malformed acknowledgement', {
          cause: error,
        });
      }
      if (acknowledgement) {
        this.queuedPackets.splice(index, 1);
        return acknowledgement;
      }
    }
    return null;
  }

  private unwrapAcknowledgement(name: string, acknowledgement: unknown[]): unknown[] {
    const [rawError, ...result] = acknowledgement;
    if (!rawError) return result;

    const message = typeof rawError === 'string'
      ? rawError
      : rawError && typeof rawError === 'object' && typeof (rawError as { message?: unknown }).message === 'string'
        ? (rawError as { message: string }).message
        : JSON.stringify(rawError);
    const code = /version|out[ -]?of[ -]?sync|stale/i.test(message)
      ? 'VERSION_CONFLICT'
      : name === 'applyOtUpdate'
        ? 'MUTATION_REJECTED'
        : 'PROTOCOL_ERROR';
    throw new OlcliError(code, `${name} failed: ${message}`, {
      details: { operation: name },
    });
  }

  private applyResponseCookies(headers: Record<string, string | string[]>): void {
    this.options.applyResponseCookies?.(headers);
  }

  private async request(url: string, options: SocketHttpRequestOptions): Promise<SocketHttpResponse> {
    try {
      return await this.options.request(url, options);
    } catch (error) {
      if (error instanceof OlcliError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|timed out/i.test(message)) {
        throw new OlcliError('SOCKET_TIMEOUT', 'Socket request timed out', { cause: error });
      }
      throw new OlcliError('PROTOCOL_ERROR', 'Socket request failed', { cause: error });
    }
  }
}
