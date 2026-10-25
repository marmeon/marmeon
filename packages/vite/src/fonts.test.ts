import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fallbackFace } from './fonts.ts';
import { marmeon } from './plugin.ts';
import { woff2 } from './__fixtures__/fonts.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));

/** Above Vite's inline limit (4 KiB), so that the build emits the file instead of embedding it. */
const FONT_SIZE = 6000;

/** An app with `count` font files in a package of its own, all loaded from its stylesheet; `fonts` is the `marmeon()` option as written. */
function app({ count = 1, fonts, size = FONT_SIZE, viteConfig = '', font }: { count?: number; fonts: string; size?: number; viteConfig?: string; font?: Buffer }): string {
  const root = tempDir('marmeon-fonts-');
  const files: Record<string, string | Buffer> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'index.html': '<!doctype html><html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>',
    'bootstrap/client.ts': "import './fonts.css';\nimport 'virtual:marmeon/fonts.css';\ndocument.title = 'fonts';\n",
    'bootstrap/ssr.ts': 'export const render = async () => ({ html: "" });\n',
    'bootstrap/fonts.css': Array.from({ length: count }, (_, index) => `@font-face { font-family: F${index}; src: url(fontpkg/files/f${index}.woff2) format('woff2'); }`).join('\n'),
    'vite.config.ts': `import { marmeon } from '@marmeon/vite';\nexport default { plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' }, fonts: ${fonts} })]${viteConfig} };\n`,
  };
  // Different bytes each: Vite emits equal content once, under the first name.
  for (let index = 0; index < count; index++) files[`node_modules/fontpkg/files/f${index}.woff2`] = Buffer.alloc(size, index + 1);
  if (font) files['node_modules/fontpkg/files/f0.woff2'] = font;
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

  it('adds a fallback font sized from the metrics of the file to the bundled stylesheet', () => {
    const font = Buffer.concat([woff2({ unitsPerEm: 1000, ascender: 1025, descender: -275, lineGap: 0, xAvgCharWidth: 533 }), Buffer.alloc(FONT_SIZE)]);
    const root = app({ fonts: "[{ file: 'fontpkg/files/f0.woff2', family: 'Fixture Sans-2', fallback: 'Arial' }]", font });
    const { code, out } = build(root);
    expect(out).toContain('Built dist/client');
    expect(code).toBe(0);
    const assets = join(root, 'dist/client/assets');
    const css = readdirSync(assets)
      .filter((name) => name.endsWith('.css'))
      .map((name) => readFileSync(join(assets, name), 'utf8'))
      .join('\n');
    expect(css).toContain('font-family:Fixture Sans-2 Fallback');
    expect(css).toContain('src:local(Arial)');
    expect(css).toContain('size-adjust:120.75%');
  }, 60_000);

  it('writes the face from the formulas: the width scales the fallback, the line box divides by that scale', () => {
    const font = { unitsPerEm: 1000, ascender: 1025, descender: -275, lineGap: 0, xAvgCharWidth: 533 };
    expect(fallbackFace('Fixture Sans', 'Arial', font)).toMatchInlineSnapshot(`
      "@font-face {
        font-family: 'Fixture Sans Fallback';
        src: local('Arial');
        size-adjust: 120.7504%;
        ascent-override: 84.8858%;
        descent-override: 22.7742%;
        line-gap-override: 0%;
      }
      "
    `);
    // A font that is the fallback itself needs no scaling.
    const same = fallbackFace('Fixture Sans', 'Courier New', { unitsPerEm: 2048, ascender: 1705, descender: -615, lineGap: 0, xAvgCharWidth: 1229 });
    expect(same).toContain('size-adjust: 100%;');
    expect(same).toContain('ascent-override: 83.252%;');
  });

  it('stops the build for a file that is no font, naming it', () => {
    const root = app({ fonts: "[{ file: 'fontpkg/files/f0.woff2', family: 'Broken', fallback: 'Arial' }]" });
    const { code, out } = build(root);
    expect(code).not.toBe(0);
    expect(out).toContain('cannot read the metrics of the font fontpkg/files/f0.woff2');
  }, 60_000);

  it('refuses a family that could end the CSS string, a fallback off the list, and one half of the pair', () => {
    const file = 'pkg/files/a.woff2';
    for (const family of ["x'; } body { color: red; } @font-face { font-family: 'y", 'a"b', 'a\\b', 'a;b', 'a}b', '', ' ', '-', 'a'.repeat(65)]) {
      expect(() => marmeon({ fonts: [{ file, family, fallback: 'Arial' }] }), family).toThrow(/letters, digits, spaces and `-`/);
    }
    // @ts-expect-error not on the list
    expect(() => marmeon({ fonts: [{ file, family: 'Plex', fallback: "Arial'); } body { x: url(//evil" }] })).toThrow(/not one of Arial, Helvetica/);
    // @ts-expect-error not on the list
    expect(() => marmeon({ fonts: [{ file, family: 'Plex', fallback: 'toString' }] })).toThrow(/not one of/);
    // @ts-expect-error an object that prints as a name is none
    expect(() => marmeon({ fonts: [{ file, family: 'Plex', fallback: { toString: () => 'Arial' } }] })).toThrow(/not one of/);
    expect(() => marmeon({ fonts: [{ file, family: 'Plex', fallback: 'Arial' }, { file: 'pkg/files/b.woff2', family: 'Plex', fallback: 'Georgia' }] })).toThrow(/two `fonts` entries have the `family` "Plex"/);
    expect(() => marmeon({ fonts: [{ file, family: 'Plex' }] })).toThrow(/both `family` and `fallback`/);
    expect(() => marmeon({ fonts: [{ file, fallback: 'Arial' }] })).toThrow(/both `family` and `fallback`/);
    expect(() => marmeon({ fonts: [{ file, family: 'IBM Plex Sans Variable', fallback: 'Times New Roman' }] })).not.toThrow();
  });
});
