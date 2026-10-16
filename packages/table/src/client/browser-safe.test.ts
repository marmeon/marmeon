import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';

const packages = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The page contract and the client core — the only code outside `table/src/client/` the table's browser half may run (it imports
 * `http/page` and `http/client`), never the server's.
 */
const ALLOWED = ['http/src/page.ts', 'http/src/protocol.ts', 'http/src/upload-header.ts', 'http/src/live-protocol.ts', 'http/src/tab-sync-protocol.ts', 'router/src/url.ts'];
const CLIENT_CORE = 'http/src/client/';

describe('@marmeon/table/client is browser-safe', () => {
  it('bundles nothing but itself, the page contract and the client core — no server code, no Node built-ins, no dependency', async () => {
    const externals = new Set<string>();
    const output = (await build({
      configFile: false,
      logLevel: 'silent',
      resolve: { conditions: ['@marmeon/source', 'browser', 'module', 'import', 'default'] },
      build: {
        write: false,
        minify: false,
        lib: { entry: fileURLToPath(new URL('./index.ts', import.meta.url)), formats: ['es'], fileName: 'entry' },
        rolldownOptions: {
          external: (id, importer) => {
            const bare = importer !== undefined && !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !id.startsWith('@marmeon/');
            if (bare || id.startsWith('node:')) {
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
      for (const chunk of chunks) if (chunk.type === 'chunk') for (const id of chunk.moduleIds) if (!id.startsWith('\0')) modules.add(relative(packages, id).replaceAll('\\', '/'));
    }
    expect([...externals]).toEqual([]);
    expect([...modules].filter((id) => !id.startsWith('table/src/client/') && !id.startsWith(CLIENT_CORE) && !ALLOWED.includes(id))).toEqual([]);
    expect([...modules]).toEqual(expect.arrayContaining(['table/src/client/index.ts', 'table/src/client/table.ts', 'http/src/client/features/selection.ts']));
  }, 30_000);
});
