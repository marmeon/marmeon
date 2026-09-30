import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createProductionRenderer } from './production.ts';

const root = mkdtempSync(join(tmpdir(), 'bespoke-prod-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function build(asset: string): void {
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  writeFileSync(join(root, 'dist/client/index.html'), `<html><head><script src="/assets/${asset}"></script></head><body><!--app-html--></body></html>`);
  writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "<p>hi</p>" });');
}

describe('createProductionRenderer', () => {
  it('derives the asset version from the build — a new build, a new version', async () => {
    build('index-a1b2.js');
    const first = await createProductionRenderer({ root, ssrEntry: 'bootstrap/ssr.tsx' });
    expect(first.version).toMatch(/^[0-9a-f]{12}$/);
    expect((await createProductionRenderer({ root, ssrEntry: 'bootstrap/ssr.tsx' })).version).toBe(first.version);

    build('index-c3d4.js');
    expect((await createProductionRenderer({ root, ssrEntry: 'bootstrap/ssr.tsx' })).version).not.toBe(first.version);
  });
});
