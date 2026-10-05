import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProductionRenderer } from './production.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const root = tempDir('bespoke-prod-');

function build(asset: string): void {
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  writeFileSync(join(root, 'dist/client/index.html'), `<html><head><script src="/assets/${asset}"></script></head><body><!--app-html--></body></html>`);
  writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "<p>hi</p>" });');
}

describe('createProductionRenderer', () => {
  it('asks for a build when there is none', async () => {
    await expect(createProductionRenderer({ root: join(root, 'nothing-built') })).rejects.toThrow(
      'No production build in dist/client — run `bespoke build` first.',
    );
  });

  it('derives the asset version from the build — a new build, a new version', async () => {
    build('index-a1b2.js');
    const first = await createProductionRenderer({ root });
    expect(first.version).toMatch(/^[0-9a-f]{12}$/);
    expect((await createProductionRenderer({ root })).version).toBe(first.version);

    build('index-c3d4.js');
    expect((await createProductionRenderer({ root })).version).not.toBe(first.version);
  });
});
