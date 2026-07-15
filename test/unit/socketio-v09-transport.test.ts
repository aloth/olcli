import { describe, expect, it } from 'vitest';

import { OlcliError } from '../../src/errors/olcli-error.js';
import {
  SocketIoV09Transport,
  type SocketHttpRequester,
  type SocketHttpResponse,
} from '../../src/realtime/socketio-v09-transport.js';

const OK_HEADERS: Record<string, string | string[]> = {};

function response(body: string, headers = OK_HEADERS): SocketHttpResponse {
  return { status: 200, ok: true, headers, body };
}

function frame(...packets: string[]): string {
  return packets.map(packet => `\ufffd${packet.length}\ufffd${packet}`).join('');
}

function scriptedRequester(
  responses: SocketHttpResponse[],
  requests: Array<{ url: string; method: string; body?: string }>
): SocketHttpRequester {
  return async (url, options) => {
    requests.push({ url, method: options.method || 'GET', body: options.body });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
    return next;
  };
}

describe('SocketIoV09Transport', () => {
  it('opens, handles heartbeats, correlates out-of-order acknowledgements, and closes', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const frames: string[] = [];
    const appliedCookies: Array<Record<string, string | string[]>> = [];
    const joinEvent = '5:::{"name":"joinProjectResponse","args":[{"project":{"name":"Test"}}]}';
    const responses = [
      response('socket-id:15:60:xhr-polling', { 'set-cookie': ['route=one'] }),
      response(frame('2::', joinEvent)),
      response('ok'), // heartbeat response
      response('ok'), // RPC 1 post
      response(frame('6:::2+[null,"two"]', '6:::1+[null,"one"]')),
      response('ok'), // RPC 2 post
      response('ok'), // disconnect
    ];
    let id = 0;
    const transport = new SocketIoV09Transport({
      baseUrl: 'https://example.test',
      projectId: 'project-1',
      request: scriptedRequester(responses, requests),
      headers: () => ({ Cookie: 'overleaf_session2=secret' }),
      applyResponseCookies: headers => appliedCookies.push(headers),
      onProtocolFrame: (direction, packet) => frames.push(`${direction}:${packet}`),
      nextRequestId: () => ++id,
      now: () => 123,
    });

    await transport.open();
    expect(transport.isOpen).toBe(true);
    expect(transport.joinProjectArgs).toEqual([{ project: { name: 'Test' } }]);
    expect(await transport.rpc('first', [])).toEqual(['one']);
    expect(await transport.rpc('second', [])).toEqual(['two']);
    await transport.close();

    expect(transport.isOpen).toBe(false);
    expect(requests.map(item => `${item.method}:${item.body || ''}`)).toEqual([
      'GET:',
      'GET:',
      'POST:2::',
      'POST:5:1+::{"name":"first","args":[]}',
      'GET:',
      'POST:5:2+::{"name":"second","args":[]}',
      'POST:0::',
    ]);
    expect(frames).toContain('send:2::');
    expect(frames).toContain('receive:6:::1+[null,"one"]');
    expect(appliedCookies[0]).toEqual({ 'set-cookie': ['route=one'] });
    expect(responses).toEqual([]);
  });

  it('classifies version errors and acknowledgement timeouts', async () => {
    const versionRequests: Array<{ url: string; method: string; body?: string }> = [];
    const versionTransport = new SocketIoV09Transport({
      baseUrl: 'https://example.test',
      projectId: 'project-1',
      request: scriptedRequester([
        response('sid:15:60:xhr-polling'),
        response('5:::{"name":"joinProjectResponse","args":[]}'),
        response('ok'),
        response('6:::1+["document version is stale"]'),
        response('ok'),
      ], versionRequests),
      headers: () => ({}),
      nextRequestId: () => 1,
    });
    await versionTransport.open();
    await expect(versionTransport.rpc('applyOtUpdate', []))
      .rejects.toMatchObject<Partial<OlcliError>>({ code: 'VERSION_CONFLICT' });
    await versionTransport.close();

    const timeoutTransport = new SocketIoV09Transport({
      baseUrl: 'https://example.test',
      projectId: 'project-2',
      request: scriptedRequester([
        response('sid:15:60:xhr-polling'),
        response('5:::{"name":"joinProjectResponse","args":[]}'),
        response('ok'),
        response('3:::unrelated'),
        response('ok'),
      ], []),
      headers: () => ({}),
      acknowledgementPollAttempts: 1,
    });
    await timeoutTransport.open();
    await expect(timeoutTransport.rpc('joinDoc', []))
      .rejects.toMatchObject<Partial<OlcliError>>({ code: 'SOCKET_TIMEOUT' });
    await timeoutTransport.close();
  });

  it('disconnects after a failed handshake sequence', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const transport = new SocketIoV09Transport({
      baseUrl: 'https://example.test',
      projectId: 'project-1',
      request: scriptedRequester([
        response('sid:15:60:xhr-polling'),
        response('1::'),
        response('ok'),
      ], requests),
      headers: () => ({}),
      handshakePollAttempts: 1,
    });

    await expect(transport.open())
      .rejects.toMatchObject<Partial<OlcliError>>({ code: 'SOCKET_HANDSHAKE_FAILED' });
    expect(requests.at(-1)).toMatchObject({ method: 'POST', body: '0::' });
  });
});
