import { describe, expect, it } from 'vitest';

import { defaultUploadRemotePath } from '../../src/upload-path.js';

describe('defaultUploadRemotePath', () => {
  it('preserves a relative project subfolder', () => {
    expect(defaultUploadRemotePath('figures/plot.pdf')).toBe('figures/plot.pdf');
  });

  it('removes an explicit current-directory prefix', () => {
    expect(defaultUploadRemotePath('./sections/methods.tex')).toBe('sections/methods.tex');
  });

  it('normalizes relative segments', () => {
    expect(defaultUploadRemotePath('figures/../plot.pdf')).toBe('plot.pdf');
  });

  it('uses the basename for an absolute POSIX path', () => {
    expect(defaultUploadRemotePath('/tmp/private/build/result.txt')).toBe('result.txt');
  });

  it('uses the basename for a parent-directory path', () => {
    expect(defaultUploadRemotePath('../outside/result.txt')).toBe('result.txt');
  });

  it('recognizes an absolute Windows path on every host platform', () => {
    expect(defaultUploadRemotePath('C:\\Users\\person\\result.txt')).toBe('result.txt');
  });
});
