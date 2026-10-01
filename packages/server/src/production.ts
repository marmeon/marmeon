import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SsrRender } from '@bespokecore/http';
import { renderDocument } from './html.ts';
import type { PageRenderer } from './render.ts';

export interface ProductionOptions {
  root: string;
  /** Build output, relative to `root` (what `bespoke()` from `@bespokecore/vite` writes). */
  clientDir?: string;
  /** The SSR bundle, relative to `root`. */
  ssrBundle?: string;
}

/** Loads the built template and SSR bundle once at boot. */
export async function createProductionRenderer({
  root,
  clientDir = 'dist/client',
  ssrBundle = 'dist/server/ssr.js',
}: ProductionOptions): Promise<PageRenderer> {
  const template = await readFile(join(root, clientDir, 'index.html'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'ENOENT' ? new Error(`No production build in ${clientDir} — run \`bespoke build\` first.`) : error;
  });
  const { render } = (await import(pathToFileURL(join(root, ssrBundle)).href)) as { render: SsrRender };

  return {
    render: async (page) => renderDocument(template, page, await render(page)),
    // The built index.html names every hashed asset: it changes exactly when the assets do.
    version: createHash('sha256').update(template).digest('hex').slice(0, 12),
  };
}
