/** Decode a Socket.IO 0.9 payload into its individual packets. */
export function decodeSocketIoV09Payload(payload: string): string[] {
  if (!payload) return [];
  if (!payload.startsWith('\ufffd')) return [payload];

  const packets: string[] = [];
  let offset = 0;

  while (offset < payload.length) {
    if (payload[offset] !== '\ufffd') {
      throw new Error(`Malformed Socket.IO payload at offset ${offset}`);
    }
    offset += 1;

    const lengthStart = offset;
    while (offset < payload.length && payload[offset] !== '\ufffd') offset += 1;
    if (offset >= payload.length) {
      throw new Error('Malformed Socket.IO payload: unterminated frame length');
    }

    const lengthText = payload.slice(lengthStart, offset);
    if (!/^\d+$/.test(lengthText)) {
      throw new Error(`Malformed Socket.IO payload: invalid frame length "${lengthText}"`);
    }
    offset += 1;

    const packetLength = Number.parseInt(lengthText, 10);
    const packetEnd = offset + packetLength;
    if (packetEnd > payload.length) {
      throw new Error(`Malformed Socket.IO payload: expected ${packetLength} frame characters`);
    }

    packets.push(payload.slice(offset, packetEnd));
    offset = packetEnd;
  }

  return packets;
}

export function encodeSocketIoV09Event(id: number, name: string, args: unknown[]): string {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error('Socket.IO event id must be a non-negative safe integer');
  }
  return `5:${id}+::${JSON.stringify({ name, args })}`;
}

export function parseSocketIoV09Ack(packet: string, id: number): unknown[] | null {
  const match = packet.match(/^6:::(\d+)(.*)$/);
  if (!match || Number.parseInt(match[1], 10) !== id) return null;

  let payload = match[2] || '';
  if (payload.startsWith('+')) payload = payload.slice(1);
  if (!payload) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error(`Malformed Socket.IO acknowledgement for id ${id}`, { cause: error });
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function parseSocketIoV09Event(packet: string): { name: string; args: unknown[] } | null {
  if (!packet.startsWith('5:::')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(packet.slice(4));
  } catch (error) {
    throw new Error('Malformed Socket.IO event packet', { cause: error });
  }

  if (
    typeof parsed !== 'object'
    || parsed === null
    || typeof (parsed as { name?: unknown }).name !== 'string'
  ) {
    throw new Error('Malformed Socket.IO event packet: missing event name');
  }

  const args = (parsed as { args?: unknown }).args;
  return {
    name: (parsed as { name: string }).name,
    args: Array.isArray(args) ? args : [],
  };
}
