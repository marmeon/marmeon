import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { Output } from './output.ts';

vi.mock('./check/internal-imports.ts', () => ({
  internalImports: () => {
    throw new Error('EACCES: cannot read');
  },
}));

afterEach(() => vi.restoreAllMocks());

describe('marmeon build when the scan for framework internals throws', () => {
  it('warns, goes on, and returns the code it returns without the scan', async () => {
    const { BuildCommand } = await import('./commands/build.ts');
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // No bootstrap/app.ts and no Vite: the build ends where it ends for any app without them.
    const code = await new BuildCommand().handle({ args: [], options: { 'no-typecheck': true }, output: new Output(), root: tempDir('marmeon-build-'), spawn: async () => 0 } as never);
    expect(written.join('')).toContain('the scan for framework internals could not run: EACCES: cannot read');
    expect(code).toBe(1);
    expect(written.join('')).toMatch(/Vite|vite/);
  });
});
