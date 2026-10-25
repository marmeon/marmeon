import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { marmeon } from './plugin.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));

/** Above Vite's inline limit (4 KiB), so that the build emits the file instead of embedding it. */
const FONT_SIZE = 6000;

/** An app with `count` font files in a package of its own, all loaded from its stylesheet; `fonts` is the `marmeon()` option as written. */
function app({ count = 1, fonts, size = FONT_SIZE, viteConfig = '' }: { count?: number; fonts: string; size?: number; viteConfig?: string }): string {
  const root = tempDir('marmeon-fonts-');
  const files: Record<string, string | Buffer> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'index.html': '<!doctype html><html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>',
    'bootstrap/client.ts': "import './fonts.css';\ndocument.title = 'fonts';\n",
    'bootstrap/ssr.ts': 'export const render = async () => ({ html: "" });\n',
    'bootstrap/fonts.css': Array.from({ length: count }, (_, index) => `@font-face { font-family: F${index}; src: url(fontpkg/files/f${index}.woff2) format('woff2'); }`).join('\n'),
    'vite.config.ts': `import { marmeon } from '@marmeon/vite';\nexport default { plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' }, fonts: ${fonts} })]${viteConfig} };\n`,
  };
  // Different bytes each: Vite emits equal content once, under the first name.
  for (let index = 0; index < count; index++) files[`node_modules/fontpkg/files/f${index}.woff2`] = Buffer.alloc(size, index + 1);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, 'node_modules/@marmeon'), { recursive: true });
  symlinkSync(vitePackage, join(root, 'node_modules/vite'), 'dir');
  symlinkSync(join(repo, 'packages/vite'), join(root, 'node_modules/@marmeon/vite'), 'dir');
  return root;
}

function build(root: string): { code: number | null; out: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV' || key === 'NODE_OPTIONS') delete env[key];
  const result = spawnSync(process.execPath, [join(repo, 'packages/cli/bin/marmeon.js'), 'build'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('the fonts option of marmeon()', () => {
  it('preloads each named font from the built index.html under its hashed URL, with crossorigin', () => {
    const root = app({ count: 2, fonts: "[{ file: 'fontpkg/files/f1.woff2' }]" });
    const { code, out } = build(root);
    expect(out).toContain('Built dist/client');
    expect(code).toBe(0);
    const html = readFileSync(join(root, 'dist/client/index.html'), 'utf8');
    // Only the named file, not every font the stylesheet loads.
    const preloads = html.match(/<link rel="preload"[^>]*>/g) ?? [];
    expect(preloads).toHaveLength(1);
    expect(preloads[0]).toMatch(/as="font"/);
    expect(preloads[0]).toMatch(/type="font\/woff2"/);
    expect(preloads[0]).toMatch(/crossorigin/);
    expect(preloads[0]).toMatch(/href="\/assets\/f1-[\w-]+\.woff2"/);
  }, 60_000);

  it('stops the build for a font it did not emit, naming the file', () => {
    const root = app({ fonts: "[{ file: 'fontpkg/files/missing.woff2' }]" });
    const { code, out } = build(root);
    expect(code).not.toBe(0);
    expect(out).toContain('the font fontpkg/files/missing.woff2 is not in the build');
  }, 60_000);

  it('warns for more than four preloads, and still builds', () => {
    const names = [0, 1, 2, 3, 4].map((index) => `{ file: 'fontpkg/files/f${index}.woff2' }`).join(', ');
    const root = app({ count: 5, fonts: `[${names}]` });
    const { code, out } = build(root);
    expect(code).toBe(0);
    expect(out.match(/`fonts` names 5 files/g)).toHaveLength(1);
    expect(readFileSync(join(root, 'dist/client/index.html'), 'utf8').match(/rel="preload"/g)).toHaveLength(5);
  }, 60_000);

  it('does not warn for four', () => {
    const names = [0, 1, 2, 3].map((index) => `{ file: 'fontpkg/files/f${index}.woff2' }`).join(', ');
    const { code, out } = build(app({ count: 4, fonts: `[${names}]` }));
    expect(code).toBe(0);
    expect(out).not.toContain('`fonts` names');
  }, 60_000);

  it('preloads a font below the inline limit, and under a base path', () => {
    const root = app({ fonts: "[{ file: 'fontpkg/files/f0.woff2' }]", size: 2000, viteConfig: ", base: '/app/'" });
    const { code, out } = build(root);
    expect(out).toContain('Built dist/client');
    expect(code).toBe(0);
    expect(readFileSync(join(root, 'dist/client/index.html'), 'utf8')).toMatch(/<link rel="preload"[^>]*href="\/app\/assets\/f0-[\w-]+\.woff2"/);
  }, 60_000);

  it('adds no preload plugin under test: true, but still checks the entries', () => {
    expect(marmeon({ test: true, fonts: [{ file: 'pkg/a.woff2' }] }).map((plugin) => plugin.name)).not.toContain('marmeon:preload-fonts');
    expect(() => marmeon({ test: true, fonts: [{ file: 'pkg/a.ttf' }] })).toThrow(TypeError);
  });

  it('refuses anything but a package-relative .woff2 path in the config', () => {
    expect(() => marmeon({ fonts: [{ file: 'pkg/files/a.ttf' }] })).toThrow(/takes \.woff2 files, got "pkg\/files\/a\.ttf"/);
    expect(() => marmeon({ fonts: [{ file: 'pkg/files/a.woff' }] })).toThrow(TypeError);
    // @ts-expect-error `file` is required
    expect(() => marmeon({ fonts: [{}] })).toThrow(TypeError);
    for (const file of ['/etc/a.woff2', '../a.woff2', 'pkg/../a.woff2', 'C:\\a.woff2', 'pkg\\a.woff2', 'pkg//a.woff2']) {
      expect(() => marmeon({ fonts: [{ file }] }), file).toThrow(/package-relative/);
    }
    expect(() => marmeon({ fonts: [{ file: '@fontsource/x/files/a.woff2' }] })).not.toThrow();
  });
});
