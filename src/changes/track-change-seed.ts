import { randomBytes } from 'node:crypto';

/** Generate the 18-character ObjectId prefix consumed by Overleaf's ranges tracker. */
export function generateTrackChangeSeed(now: Date = new Date()): string {
  const timestamp = Math.floor(now.valueOf() / 1000).toString(16).padStart(8, '0').slice(-8);
  const machine = randomBytes(3).toString('hex');
  const process = randomBytes(2).toString('hex');
  return `${timestamp}${machine}${process}`;
}
