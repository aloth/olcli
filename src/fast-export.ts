/**
 * Byte-exact reading of the git remote-helper protocol and fast-export streams.
 *
 * Commands are newline-terminated text, but `data <N>` payloads are exactly N
 * raw bytes that may contain anything, including invalid UTF-8, NUL and \r\n.
 * A line-oriented reader such as readline decodes those bytes as text and
 * cannot give them back, so payloads are read here as Buffers of exact length.
 */

export interface ByteSource {
  /** Next line without its trailing \n (and \r), or null at end of input. */
  readLine(): Promise<string | null>;
  /** Exactly n bytes, or fewer only if the input ends first. */
  readBytes(n: number): Promise<Buffer>;
}

/** Buffers an async byte stream (e.g. process.stdin) for line and byte reads. */
export class ByteReader implements ByteSource {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private readonly it: AsyncIterator<Buffer | string>;

  constructor(stream: AsyncIterable<Buffer | string>) {
    this.it = stream[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const { value, done } = await this.it.next();
    if (done) {
      this.ended = true;
      return false;
    }
    const chunk = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    return true;
  }

  async readLine(): Promise<string | null> {
    let from = 0;
    for (;;) {
      const nl = this.buf.indexOf(0x0a, from);
      if (nl !== -1) {
        let end = nl;
        if (end > 0 && this.buf[end - 1] === 0x0d) end--;
        const line = this.buf.subarray(0, end).toString('utf-8');
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      from = this.buf.length;
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null;
        const line = this.buf.toString('utf-8');
        this.buf = Buffer.alloc(0);
        return line;
      }
    }
  }

  async readBytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (!(await this.fill())) break;
    }
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(Math.min(n, this.buf.length));
    return out;
  }
}

export interface ExportedFile {
  path: string;
  content: Buffer;
}

export interface ExportedDelete {
  path: string;
}

export interface ParsedExport {
  files: ExportedFile[];
  deletes: ExportedDelete[];
}

/** Unquote a fast-export path (C-style quoting for unusual names). */
function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf-8'));
      continue;
    }
    const n = body[++i];
    if (n >= '0' && n <= '7') {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Read a fast-export stream up to "done" and collect file modifications and
 * deletions. Blob payloads are kept as raw bytes.
 */
export async function parseFastExport(src: ByteSource): Promise<ParsedExport> {
  const files: ExportedFile[] = [];
  const deletes: ExportedDelete[] = [];
  const blobData = new Map<string, Buffer>(); // mark -> data

  let currentMark = '';
  let pendingInlinePath: string | null = null;
  let commitSection = false;

  for (;;) {
    const line = await src.readLine();
    if (line === null || line === 'done') break;
    if (line === '') continue;

    if (line.startsWith('data ')) {
      const spec = line.slice(5);
      let data: Buffer;
      if (spec.startsWith('<<')) {
        // Delimited format: data <<DELIM ... DELIM
        const delim = spec.slice(2);
        const parts: string[] = [];
        for (;;) {
          const l = await src.readLine();
          if (l === null || l === delim) break;
          parts.push(l + '\n');
        }
        data = Buffer.from(parts.join(''), 'utf-8');
      } else {
        data = await src.readBytes(parseInt(spec, 10));
      }
      if (pendingInlinePath !== null) {
        files.push({ path: pendingInlinePath, content: data });
        pendingInlinePath = null;
      } else if (!commitSection && currentMark) {
        blobData.set(currentMark, data);
      }
      continue;
    }

    if (line === 'blob') {
      commitSection = false;
      currentMark = '';
      continue;
    }

    if (line.startsWith('mark :')) {
      currentMark = line.slice(6);
      continue;
    }

    if (line.startsWith('commit ')) {
      commitSection = true;
      currentMark = '';
      continue;
    }

    // File modification: M <mode> :<mark> <path>
    const mMatch = line.match(/^M \d+ :(\S+) (.+)$/);
    if (mMatch) {
      const [, markRef, path] = mMatch;
      const content = blobData.get(markRef);
      if (content) files.push({ path: unquotePath(path), content });
      continue;
    }

    // Inline modification: M <mode> inline <path>, followed by data
    const mInline = line.match(/^M \d+ inline (.+)$/);
    if (mInline) {
      pendingInlinePath = unquotePath(mInline[1]);
      continue;
    }

    // Deletion: D <path>
    const dMatch = line.match(/^D (.+)$/);
    if (dMatch) {
      deletes.push({ path: unquotePath(dMatch[1]) });
      continue;
    }
    // author, committer, from, merge, reset, feature, ... carry nothing we need
  }

  return { files, deletes };
}
