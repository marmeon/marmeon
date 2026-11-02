import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageObject } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { createProductionRenderer } from './production.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const root = tempDir('marmeon-prod-');

const manifest = {
  'index.html': { file: 'assets/index-a1.js', isEntry: true },
  'modules/demo/views/Home.tsx': { file: 'assets/Home-b2.js', isDynamicEntry: true, imports: ['index.html'] },
};

function build(asset: string, manifestText: string | null = JSON.stringify(manifest)): void {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  writeFileSync(join(root, 'dist/client/index.html'), `<html><head><script src="/assets/${asset}"></script><!--app-head--></head><body><!--app-html--></body></html>`);
  if (manifestText !== null) {
    mkdirSync(join(root, 'dist/client/.vite'), { recursive: true });
    writeFileSync(join(root, 'dist/client/.vite/manifest.json'), manifestText);
  }
  writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "<p>hi</p>" });');
}

describe('createProductionRenderer', () => {
  it('asks for a build when there is none', async () => {
    await expect(createProductionRenderer({ root: join(root, 'nothing-built') })).rejects.toThrow(
      'No production build in dist/client — run `marmeon build` first.',
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

  const page = { component: 'demo/Home', props: {}, url: '/', version: null } as unknown as PageObject;

  it("preloads the page's chunks in the shell, with the nonce; the entry stays the template's", async () => {
    build('index-a1.js');
    const html = await (await createProductionRenderer({ root })).shell(page, new Request('http://h/'), 'N0NCE');
    expect(html).toContain('<link rel="modulepreload" href="/assets/Home-b2.js" crossorigin nonce="N0NCE">');
    expect(html).not.toContain('href="/assets/index-a1.js"');
    // The outlet's content (the page object) comes after the preloads.
    expect(html.indexOf('modulepreload')).toBeGreaterThan(-1);
    expect(html.indexOf('modulepreload')).toBeLessThan(html.indexOf('id="marmeon-page"'));
  });

  it('starts without a manifest and preloads nothing', async () => {
    build('index-a1.js', null);
    const html = await (await createProductionRenderer({ root })).shell(page, new Request('http://h/'), 'N0NCE');
    expect(html).not.toContain('modulepreload');
  });

  it('refuses to boot with a path base, with a manifest or without', async () => {
    for (const manifestText of [JSON.stringify(manifest), null]) {
      build('index-a1.js', manifestText);
      const index = join(root, 'dist/client/index.html');
      writeFileSync(index, '<html><head><script type="module" src="/static/assets/index-a1.js"></script></head><body></body></html>');
      await expect(createProductionRenderer({ root })).rejects.toThrow("`base` is '/static/'");
    }
  });

  it('refuses to boot with a malformed manifest', async () => {
    build('index-a1.js', '{ "a": { "file": 1 } }');
    await expect(createProductionRenderer({ root })).rejects.toThrow('dist/client/.vite/manifest.json is not a Vite manifest — run `marmeon build` again.');
    build('index-a1.js', 'not json');
    await expect(createProductionRenderer({ root })).rejects.toThrow('is not a Vite manifest');
  });
});
