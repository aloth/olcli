import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const server = JSON.parse(readFileSync(join(root, 'server.json'), 'utf-8'));

// The MCP registry checks that server.json names the npm package that carries
// the matching mcpName, at the version given. A release that bumps
// package.json and forgets server.json would publish a stale entry.
test('server.json matches package.json', () => {
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  const [npm] = server.packages;
  assert.equal(npm.registryType, 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.ok(server.description.length <= 100, 'the registry rejects descriptions over 100 characters');
});

// The server is not the package's default bin, so npx has to be told which bin
// to run: npx -y --package @aloth/olcli@<version> olcli-mcp
test('server.json starts the olcli-mcp bin', () => {
  const [npm] = server.packages;
  assert.equal(npm.runtimeHint, 'npx');
  assert.deepEqual(npm.runtimeArguments.map((a: { value: string }) => a.value), ['-y', '--package']);
  assert.deepEqual(npm.packageArguments.map((a: { value: string }) => a.value), ['olcli-mcp']);
  assert.equal(pkg.bin['olcli-mcp'], 'dist/mcp.js');
  const secret = npm.environmentVariables.find((v: { name: string }) => v.name === 'OVERLEAF_SESSION');
  assert.equal(secret?.isSecret, true);
});
