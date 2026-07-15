import { describe, expect, it } from 'vitest';

import {
  decodeSocketIoV09Payload,
  encodeSocketIoV09Event,
  parseSocketIoV09Ack,
  parseSocketIoV09Event,
} from '../../src/realtime/socketio-v09-framing.js';

function frame(...packets: string[]): string {
  return packets.map(packet => `\ufffd${packet.length}\ufffd${packet}`).join('');
}

describe('Socket.IO 0.9 framing', () => {
  it('decodes single and length-prefixed payloads', () => {
    expect(decodeSocketIoV09Payload('2::')).toEqual(['2::']);
    expect(decodeSocketIoV09Payload(frame('2::', '5:::{"name":"ready"}')))
      .toEqual(['2::', '5:::{"name":"ready"}']);
  });

  it('rejects truncated frames instead of returning partial data', () => {
    expect(() => decodeSocketIoV09Payload('\ufffd5\ufffdabc')).toThrow(/expected 5/);
    expect(() => decodeSocketIoV09Payload('\ufffdx\ufffdabc')).toThrow(/invalid frame length/);
  });

  it('encodes events and correlates acknowledgements by id', () => {
    expect(encodeSocketIoV09Event(42, 'joinDoc', ['doc-1']))
      .toBe('5:42+::{"name":"joinDoc","args":["doc-1"]}');
    expect(parseSocketIoV09Ack('6:::42+[null,{"version":7}]', 42))
      .toEqual([null, { version: 7 }]);
    expect(parseSocketIoV09Ack('6:::41+[null]', 42)).toBeNull();
  });

  it('reports malformed acknowledgement JSON', () => {
    expect(() => parseSocketIoV09Ack('6:::42+not-json', 42))
      .toThrow(/Malformed Socket.IO acknowledgement/);
  });

  it('parses event packets without treating other packet types as events', () => {
    expect(parseSocketIoV09Event('5:::{"name":"joinProjectResponse","args":[{"ok":true}]}'))
      .toEqual({ name: 'joinProjectResponse', args: [{ ok: true }] });
    expect(parseSocketIoV09Event('2::')).toBeNull();
    expect(() => parseSocketIoV09Event('5:::not-json')).toThrow(/Malformed Socket.IO event/);
  });
});
