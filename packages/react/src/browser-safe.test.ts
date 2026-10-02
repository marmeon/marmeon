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
    resolve: { conditions: ['@bespokecore/source', 'browser', 'module', 'import', 'default'] },
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: 'entry' },
      rolldownOptions: {
        external: (id, importer) => {
          const bare = importer !== undefined && !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !id.startsWith('@bespokecore/');
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

describe('@bespokecore/react in the browser', () => {
  it('is a rendering layer on the client core: no server code, no i18n at runtime — React itself from the app', async () => {
    const { modules, externals } = await bundled(fileURLToPath(new URL('./index.ts', import.meta.url)));
    expect(externals.filter((id) => !/^react(-dom)?(\/|$)/.test(id))).toEqual([]);
    const allowed = (id: string) => id.startsWith('react/src/') || id.startsWith('http/src/client/') || id === 'http/src/page.ts' || id === 'router/src/url.ts';
    expect(modules.filter((id) => !allowed(id))).toEqual([]);
    expect(modules).toEqual(expect.arrayContaining(['react/src/app.tsx', 'http/src/client/navigation.ts']));
  }, 30_000);

  it('needs @bespokecore/i18n only when the app translates: an optional peer, so discovery does not add it (nor its session) to every React app', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown> | undefined>;
    expect(manifest.dependencies).not.toHaveProperty('@bespokecore/i18n');
    expect(manifest.peerDependencies).toHaveProperty('@bespokecore/i18n');
    expect(manifest.peerDependenciesMeta).toEqual(expect.objectContaining({ '@bespokecore/i18n': { optional: true } }));
  });
});
