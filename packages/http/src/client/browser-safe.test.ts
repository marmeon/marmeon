import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';

const packages = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Bundles a browser entry as an app's client build does (the workspace sources, browser conditions) and lists the
 * modules that end up in it — what a browser would run, after type-only imports are gone.
 */
async function bundled(entry: string, external: RegExp[] = []): Promise<{ modules: string[]; externals: string[] }> {
  const externals = new Set<string>();
  const output = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { conditions: ['@marmeon/source', 'browser', 'module', 'import', 'default'] },
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: 'entry' },
      rolldownOptions: {
        external: (id, importer) => {
          // Node built-ins and npm packages are collected, not bundled (Vite would stub the built-ins): the browser
          // core brings no dependency of its own.
          const bare = importer !== undefined && !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !id.startsWith('@marmeon/');
          if (bare || id.startsWith('node:') || external.some((pattern) => pattern.test(id))) {
            externals.add(id);
            return true;
          }
          return false;
        },
      },
    },
  })) as Rolldown.RolldownOutput[];
  const modules = new Set<string>();
  for (const { output: chunks } of output) {
    // The bundler's own helpers (`\0rolldown/runtime.js`, which loads the chunks of features loaded on first use) are no module of ours.
    for (const chunk of chunks) if (chunk.type === 'chunk') for (const id of chunk.moduleIds) if (!id.startsWith('\0')) modules.add(relative(packages, id).replaceAll('\\', '/'));
  }
  return { modules: [...modules].sort(), externals: [...externals].sort() };
}

/** The shared page contract and the router's URL builder — the only code outside `client/` the browser core may run. */
const SHARED = ['http/src/page.ts', 'http/src/page-support.ts', 'http/src/protocol.ts', 'http/src/sensitive-fields.ts','http/src/upload-header.ts', 'http/src/live-protocol.ts', 'http/src/tab-sync-protocol.ts', 'router/src/url.ts', 'router/src/pattern.ts'];

describe('@marmeon/http/client is browser-safe', () => {
  it('bundles nothing but the client core, the page contract and URL building — no server code, no Node built-ins', async () => {
    const { modules, externals } = await bundled(fileURLToPath(new URL('./index.ts', import.meta.url)));
    expect(externals).toEqual([]);
    const outside = modules.filter((id) => !id.startsWith('http/src/client/') && !SHARED.includes(id));
    expect(outside).toEqual([]);
    // The core itself is in there (the check above is not vacuous).
    expect(modules).toEqual(expect.arrayContaining(['http/src/client/index.ts', 'http/src/client/features/hooks.ts']));
  }, 30_000);

  it('the adapter entry (@marmeon/http/client/adapter) is browser-safe too', async () => {
    const { modules, externals } = await bundled(fileURLToPath(new URL('./adapter.ts', import.meta.url)));
    expect(externals).toEqual([]);
    expect(modules.filter((id) => !id.startsWith('http/src/client/') && !SHARED.includes(id))).toEqual([]);
    expect(modules).toEqual(expect.arrayContaining(['http/src/client/adapter.ts', 'http/src/client/navigation.ts', 'http/src/page-support.ts']));
  }, 30_000);

  it('the page protocol (@marmeon/http/protocol) is browser-safe too', async () => {
    const { modules, externals } = await bundled(fileURLToPath(new URL('../protocol.ts', import.meta.url)));
    expect(externals).toEqual([]);
    expect(modules.filter((id) => !SHARED.includes(id))).toEqual([]);
  }, 30_000);

  it('the page contract (@marmeon/http/page) is browser-safe too', async () => {
    const { modules, externals } = await bundled(fileURLToPath(new URL('../page.ts', import.meta.url)));
    expect(externals).toEqual([]);
    expect(modules.filter((id) => !SHARED.includes(id))).toEqual([]);
  }, 30_000);

  it('writes no regular-expression modifier group — older browsers refuse the whole module', () => {
    const clientDir = fileURLToPath(new URL('.', import.meta.url));
    const files = [
      ...SHARED.map((id) => join(packages, id)),
      ...readdirSync(clientDir, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => join(clientDir, name)),
    ];
    expect(files.length).toBeGreaterThan(10);
    const offending = files.filter((file) => /\(\?[-ims]+(?:-[ims]+)?:/.test(readFileSync(file, 'utf8')));
    expect(offending.map((file) => relative(packages, file))).toEqual([]);
  });
});
