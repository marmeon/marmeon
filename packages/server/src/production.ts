import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SsrRender } from '@bespokecore/http';
import { renderDocument } from './html.ts';
import type { PageRenderer } from './render.ts';

export interface ProductionOptions {
  root: string;
  ssrEntry: string;
  /** Build output, relative to `root`. */
  clientDir?: string;
  serverDir?: string;
}

/** Loads the built template and SSR bundle once at boot. */
export async function createProductionRenderer({
  root,
  ssrEntry,
  clientDir = 'dist/client',
  serverDir = 'dist/server',
}: ProductionOptions): Promise<PageRenderer> {
  const template = await readFile(join(root, clientDir, 'index.html'), 'utf8');
  const bundle = join(root, serverDir, `${basename(ssrEntry, extname(ssrEntry))}.js`);
  const { render } = (await import(pathToFileURL(bundle).href)) as { render: SsrRender };

  return { render: async (page) => renderDocument(template, page, await render(page)) };
}
