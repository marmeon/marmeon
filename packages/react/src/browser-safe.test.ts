import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';

const packages = fileURLToPath(new URL('../../', import.meta.url));

/** The modules a browser bundle of `entry` holds (workspace sources, browser conditions), and what it imports from outside. */
async function bundled(entry: string): Promise<{ modules: string[]; externals: string[] }> {
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
          const bare = importer !== undefined && !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !id.startsWith('@marmeon/');
          if (bare || id.startsWith('node:')) externals.add(id);
          return bare || id.startsWith('node:');
        },
      },
    },
  })) as Rolldown.RolldownOutput[];
  const modules = new Set<string>();
  for (const { output: chunks } of output) {
    // The bundler's own helpers (`\0rolldown/runtime.js`, which loads the layer stack's chunk) are no module of ours.
    for (const chunk of chunks) if (chunk.type === 'chunk') for (const id of chunk.moduleIds) if (!id.startsWith('\0')) modules.add(relative(packages, id).replaceAll('\\', '/'));
  }
  return { modules: [...modules].sort(), externals: [...externals].sort() };
}

describe('@marmeon/react in the browser', () => {
  it('is a rendering layer on the client core: no server code, no i18n at runtime — React itself from the app', async () => {
    const { modules, externals } = await bundled(fileURLToPath(new URL('./index.ts', import.meta.url)));
    expect(externals.filter((id) => !/^react(-dom)?(\/|$)/.test(id))).toEqual([]);
    const allowed = (id: string) => id.startsWith('react/src/') || id.startsWith('http/src/client/') || id === 'http/src/page.ts' || id === 'http/src/upload-header.ts' || id === 'http/src/live-protocol.ts' || id === 'http/src/tab-sync-protocol.ts' || id === 'router/src/url.ts';
    expect(modules.filter((id) => !allowed(id))).toEqual([]);
    expect(modules).toEqual(expect.arrayContaining(['react/src/app.tsx', 'http/src/client/navigation.ts']));
  }, 30_000);

  it('the table subpaths: the table’s browser half and the client core, no server code — TanStack only in the bridge, and only as an import', async () => {
    const core = (id: string) => id.startsWith('http/src/client/') || id === 'http/src/page.ts' || id === 'http/src/upload-header.ts' || id === 'http/src/live-protocol.ts' || id === 'http/src/tab-sync-protocol.ts' || id === 'router/src/url.ts';
    const table = await bundled(fileURLToPath(new URL('./table.ts', import.meta.url)));
    expect(table.modules.filter((id) => !id.startsWith('react/src/') && !id.startsWith('table/src/client/') && !core(id))).toEqual([]);
    expect(table.modules).toEqual(expect.arrayContaining(['react/src/table.ts', 'table/src/client/table.ts']));
    expect(table.externals.filter((id) => !/^react(-dom)?(\/|$)/.test(id))).toEqual([]);
    // The bridge has no TanStack code of its own (types only): an app that imports it has TanStack because it imports TanStack.
    const bridge = await bundled(fileURLToPath(new URL('./table-tanstack.ts', import.meta.url)));
    expect(bridge.externals).toEqual([]);
    expect(bridge.modules).toEqual(['react/src/table-tanstack.ts']);
    // The main entry knows neither.
    const main = await bundled(fileURLToPath(new URL('./index.ts', import.meta.url)));
    expect(main.modules.filter((id) => id.startsWith('table/') || id.includes('table'))).toEqual([]);
  }, 30_000);

  it('needs @marmeon/table and TanStack Table only for their subpaths: optional peers, so discovery does not add the table package to every React app', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown> | undefined>;
    for (const peer of ['@marmeon/table', '@tanstack/react-table']) {
      expect(manifest.dependencies).not.toHaveProperty(peer);
      expect(manifest.peerDependencies).toHaveProperty(peer);
      expect(manifest.peerDependenciesMeta).toEqual(expect.objectContaining({ [peer]: { optional: true } }));
    }
  });

  it('needs @marmeon/i18n only when the app translates: an optional peer, so discovery does not add it (nor its session) to every React app', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown> | undefined>;
    expect(manifest.dependencies).not.toHaveProperty('@marmeon/i18n');
    expect(manifest.peerDependencies).toHaveProperty('@marmeon/i18n');
    expect(manifest.peerDependenciesMeta).toEqual(expect.objectContaining({ '@marmeon/i18n': { optional: true } }));
  });
});
