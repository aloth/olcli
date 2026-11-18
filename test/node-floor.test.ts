import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEXT_NODE_MAJOR, nodeFloorNotice, nodeMajor } from '../src/node-floor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tty = { stdout: { isTTY: true }, stderr: { isTTY: true } };

test('the notice names Node 22 on an older runtime with a terminal', () => {
  assert.equal(NEXT_NODE_MAJOR, 22);
  assert.equal(nodeMajor('20.18.1'), 20);
  assert.match(nodeFloorNotice('20.18.1', tty) ?? '', /olcli 1\.0 requires Node 22 or newer; this is Node 20\.18\.1/);
  assert.ok(nodeFloorNotice('21.7.0', tty));
});

test('no notice on Node 22 or newer', () => {
  assert.equal(nodeFloorNotice('22.0.0', tty), undefined);
  assert.equal(nodeFloorNotice('24.1.0', tty), undefined);
});

test('no notice when stdout or stderr is not a terminal (pipes, CI, MCP stdio)', () => {
  assert.equal(nodeFloorNotice('20.18.1', { stdout: { isTTY: false }, stderr: { isTTY: true } }), undefined);
  assert.equal(nodeFloorNotice('20.18.1', { stdout: { isTTY: true }, stderr: {} }), undefined);
});

test('engines still allows Node 20.18.1 in 0.x, and only the olcli command prints the notice', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  assert.equal(pkg.engines.node, '>=20.18.1');
  for (const file of ['mcp.ts', 'mcp-server.ts', 'remote-helper.ts']) {
    assert.doesNotMatch(readFileSync(join(ROOT, 'src', file), 'utf-8'), /node-floor/, file);
  }
});
