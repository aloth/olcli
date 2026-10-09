import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ByteReader, parseFastExport } from '../src/fast-export.js';

// Every byte value, plus sequences that are invalid UTF-8 or look like protocol lines.
const BINARY = Buffer.concat([
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x0d, 0x0a, 0x00, 0x0a, 0xc3]),
  Buffer.from('\nM 100644 :99 evil.tex\ndone\n'),
]);
const UTF8 = '% 中文注释\nGrüße — “quotes” ü\r\nend\n';

function reader(chunks: Buffer[]): ByteReader {
  return new ByteReader(Readable.from(chunks));
}

function git(dir: string, ...args: string[]): Buffer {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
}

function fastExportStream(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'olcli-fe-'));
  try {
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'figure.png'), BINARY);
    writeFileSync(join(dir, 'main.tex'), UTF8);
    writeFileSync(join(dir, 'after.txt'), 'ascii after binary\n');
    writeFileSync(join(dir, 'old.tex'), 'gone\n');
    writeFileSync(join(dir, 'with space ü.tex'), 'quoted path\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'one');
    git(dir, 'rm', '-q', 'old.tex');
    git(dir, 'commit', '-qm', 'two');
    return Buffer.concat([git(dir, 'fast-export', '--all'), Buffer.from('done\n')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ByteReader: readBytes returns exact raw bytes across chunk boundaries', async () => {
  const r = reader([Buffer.from('data 4\n\xff'.slice(0, 7)), Buffer.from([0xff, 0x00]), Buffer.from([0x0a, 0xc3, 0x41, 0x0a])]);
  assert.equal(await r.readLine(), 'data 4');
  assert.deepEqual(await r.readBytes(4), Buffer.from([0xff, 0x00, 0x0a, 0xc3]));
  assert.equal(await r.readLine(), 'A');
  assert.equal(await r.readLine(), null);
});

test('parseFastExport: binary, UTF-8 and following files arrive byte for byte', async () => {
  const stream = fastExportStream();
  // Feed in small chunks so payloads straddle chunk boundaries.
  const chunks: Buffer[] = [];
  for (let i = 0; i < stream.length; i += 7) chunks.push(stream.subarray(i, i + 7));
  const parsed = await parseFastExport(reader(chunks));
  const last = new Map(parsed.files.map((f) => [f.path, f.content]));
  assert.deepEqual(last.get('figure.png'), BINARY);
  assert.equal(last.get('main.tex')?.toString('utf-8'), UTF8);
  assert.equal(last.get('after.txt')?.toString('utf-8'), 'ascii after binary\n');
  assert.equal(last.get('with space ü.tex')?.toString('utf-8'), 'quoted path\n');
  assert.equal(last.has('evil.tex'), false);
  assert.deepEqual(parsed.deletes.map((d) => d.path), ['old.tex']);
});

test('parseFastExport: stops at done and leaves later protocol lines unread', async () => {
  const r = reader([Buffer.from('blob\nmark :1\ndata 3\n\x00\x01\x02\nreset refs/heads/main\ncommit refs/heads/main\nmark :2\ncommitter t <t> 0 +0000\ndata 1\nx\nM 100644 :1 a.bin\n\ndone\nnext command\n', 'latin1')]);
  const parsed = await parseFastExport(r);
  assert.deepEqual(parsed.files, [{ path: 'a.bin', content: Buffer.from([0, 1, 2]) }]);
  assert.equal(await r.readLine(), 'next command');
});
