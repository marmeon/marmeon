import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { removeLeftovers } from './leftovers.ts';
import { stubHash } from './manifest.ts';

function app(files: Record<string, string>) {
  const root = tempDir('marmeon-leftovers-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const lines: string[] = [];
  const output = { success: (line: string) => lines.push(`✓ ${line}`), warn: (line: string) => lines.push(`! ${line}`) };
  const set = (paths: Record<string, string>) => ({ version: '0.1.0', files: Object.fromEntries(Object.entries(paths).map(([path, text]) => [path, { sha256: stubHash(text) }])) });
  return { root, lines, output, set };
}

describe('removeLeftovers', () => {
  it('removes a file of the named module that the app left unchanged, and nothing else', () => {
    const { root, lines, output, set } = app({ 'modules/oauth/old.ts': 'old\n', 'modules/oauth/keep.ts': 'keep\n' });
    removeLeftovers(root, 'oauth', set({ 'modules/oauth/old.ts': 'old\n', 'modules/oauth/keep.ts': 'keep\n' }), ['modules/oauth/keep.ts'], output);
    expect(existsSync(join(root, 'modules/oauth/old.ts'))).toBe(false);
    expect(existsSync(join(root, 'modules/oauth/keep.ts'))).toBe(true);
    expect(lines).toEqual(['✓ Removed modules/oauth/old.ts: the kit of 0.1.0 wrote it, this one no longer ships it, and it was unchanged.']);
  });

  it("keeps what a manifest lists outside the module's own files: another module, and the migrations of this one", () => {
    const files = { 'modules/auth/x.ts': 'x\n', 'modules/oauth/migrations/y.ts': 'y\n', 'modules/oauth/z.ts': 'z\n' };
    const { root, output, set } = app(files);
    removeLeftovers(root, 'oauth', set({ 'modules/auth/x.ts': 'x\n', 'modules/oauth/migrations/y.ts': 'y\n' }), ['modules/oauth/z.ts'], output);
    expect(existsSync(join(root, 'modules/auth/x.ts'))).toBe(true);
    expect(existsSync(join(root, 'modules/oauth/migrations/y.ts'))).toBe(true);
  });

  it('keeps a file the app changed, and names it', () => {
    const { root, lines, output, set } = app({ 'modules/oauth/old.ts': 'changed\n', 'modules/oauth/z.ts': 'z\n' });
    removeLeftovers(root, 'oauth', set({ 'modules/oauth/old.ts': 'old\n' }), ['modules/oauth/z.ts'], output);
    expect(existsSync(join(root, 'modules/oauth/old.ts'))).toBe(true);
    expect(lines).toEqual([expect.stringMatching(/^! Kept modules\/oauth\/old\.ts: .* it was changed\./)]);
  });

  it('keeps a link, whatever it leads to', () => {
    const { root, lines, output, set } = app({ 'modules/oauth/z.ts': 'z\n', 'inside.ts': 'inside\n' });
    symlinkSync(join(root, 'inside.ts'), join(root, 'modules/oauth/old.ts'));
    removeLeftovers(root, 'oauth', set({ 'modules/oauth/old.ts': 'inside\n' }), ['modules/oauth/z.ts'], output);
    expect(existsSync(join(root, 'inside.ts'))).toBe(true);
    expect(lines).toEqual(['! Kept modules/oauth/old.ts: it is no regular file.']);
  });

  it('keeps a path of the manifest whose link leaves the project', () => {
    const { root, lines, output, set } = app({ 'modules/oauth/z.ts': 'z\n' });
    const outside = tempDir('marmeon-leftovers-outside-');
    writeFileSync(join(outside, 'target.ts'), 'outside\n');
    symlinkSync(outside, join(root, 'modules/oauth/linked'), 'dir');
    removeLeftovers(root, 'oauth', set({ 'modules/oauth/linked/target.ts': 'outside\n' }), ['modules/oauth/z.ts'], output);
    expect(existsSync(join(outside, 'target.ts'))).toBe(true);
    expect(lines).toEqual(['! Kept modules/oauth/linked/target.ts: it leads out of the project.']);
  });

  it('takes only a kebab-case module name', () => {
    const { root, output, set } = app({});
    for (const name of ['../auth', 'Auth', '', 'a/b']) expect(() => removeLeftovers(root, name, set({}), [], output), name).toThrow(TypeError);
  });
});
