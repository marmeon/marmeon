import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';

const packages = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The in-page bar's client (W7 step 9) as the Vite dev server serves it: browser code only — the bar, the client core and the
 * page contract. None of the devtools' server side (recorder, store, pages: Node built-ins), whatever the client imports types of.
 */
describe('@bespokecore/devtools/client is browser-safe', () => {
  it('bundles the bar and the client core only — no server code, no Node built-ins', async () => {
    const externals = new Set<string>();
    const output = (await build({
      configFile: false,
      logLevel: 'silent',
      resolve: { conditions: ['@bespokecore/source', 'browser', 'module', 'import', 'default'] },
      build: {
        write: false,
        minify: false,
        lib: { entry: fileURLToPath(new URL('./index.ts', import.meta.url)), formats: ['es'], fileName: 'entry' },
        rolldownOptions: {
          external: (id, importer) => {
            const bare = importer !== undefined && !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !id.startsWith('@bespokecore/');
            if (bare || id.startsWith('node:')) {
              externals.add(id);
              return true;
            }
            return false;
          },
        },
      },
    })) as Rolldown.RolldownOutput[];
    const modules = output.flatMap(({ output: chunks }) => chunks.flatMap((chunk) => (chunk.type === 'chunk' ? chunk.moduleIds.filter((id) => !id.startsWith('\0')).map((id) => relative(packages, id).replaceAll('\\', '/')) : [])));
    expect([...externals]).toEqual([]);
    const shared = ['http/src/page.ts', 'http/src/upload-header.ts', 'http/src/live-protocol.ts', 'router/src/url.ts'];
    expect(modules.filter((id) => !id.startsWith('devtools/src/client/') && !id.startsWith('http/src/client/') && !shared.includes(id))).toEqual([]);
    expect(modules).toEqual(expect.arrayContaining(['devtools/src/client/index.ts', 'devtools/src/client/bar.ts', 'http/src/client/features/devtools.ts']));
  }, 30_000);
});
