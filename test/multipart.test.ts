/**
 * Unit tests for buildMultipartBody helper.
 * Run with: node --test --import tsx test/multipart.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultipartBody } from '../src/client.ts';

test('buildMultipartBody returns a Buffer', () => {
  const { body } = buildMultipartBody([
    { name: 'field1', value: 'hello' },
  ]);
  assert.ok(body instanceof Buffer, 'body should be a Buffer');
});

test('buildMultipartBody boundary is present in body and content-type string', () => {
  const { body, boundary } = buildMultipartBody([
    { name: 'targetFolderId', value: 'abc123' },
    { name: 'qqfile', filename: 'test.txt', contentType: 'text/plain', data: Buffer.from('content') },
  ]);

  assert.ok(typeof boundary === 'string' && boundary.length > 0, 'boundary should be a non-empty string');
  assert.ok(body.toString().includes(boundary), 'boundary should appear in the body');

  // Simulate the Content-Type header value that callers set
  const contentTypeHeader = `multipart/form-data; boundary=${boundary}`;
  assert.ok(contentTypeHeader.includes('boundary='), 'Content-Type header should include boundary');
});

test('buildMultipartBody includes text field values', () => {
  const { body } = buildMultipartBody([
    { name: 'name', value: 'myfile.tex' },
  ]);
  const bodyStr = body.toString();
  assert.ok(bodyStr.includes('name="name"'), 'body should include the field name');
  assert.ok(bodyStr.includes('myfile.tex'), 'body should include the field value');
});

test('buildMultipartBody includes file field data', () => {
  const fileContent = Buffer.from('hello world');
  const { body } = buildMultipartBody([
    { name: 'qqfile', filename: 'doc.tex', contentType: 'text/x-tex', data: fileContent },
  ]);
  const bodyStr = body.toString();
  assert.ok(bodyStr.includes('filename="doc.tex"'), 'body should include filename');
  assert.ok(bodyStr.includes('Content-Type: text/x-tex'), 'body should include file content-type');
  assert.ok(body.includes(fileContent), 'body should contain the raw file data');
});

test('buildMultipartBody body ends with closing boundary', () => {
  const { body, boundary } = buildMultipartBody([
    { name: 'x', value: 'y' },
  ]);
  assert.ok(body.toString().endsWith(`--${boundary}--\r\n`), 'body should end with the closing delimiter');
});
