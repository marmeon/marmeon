import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SsrRender } from '@marmeon/http';
import { assetPreloads, baseOf, parseManifest } from './preloads.ts';
import { createDocumentRenderer, type PageRenderer } from './render.ts';

export interface ProductionOptions {
  root: string;
  /** Build output, relative to `root` (what `marmeon()` from `@marmeon/vite` writes). */
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
    throw error.code === 'ENOENT' ? new Error(`No production build in ${clientDir} — run \`marmeon build\` first.`) : error;
  });
  // Without a manifest (a build that turned it off) the documents preload nothing; one that cannot be read or parsed stops the boot.
  const manifest = await readFile(join(root, clientDir, '.vite/manifest.json'), 'utf8').then(
    (text) => parseManifest(parseJson(text), `${clientDir}/.vite/manifest.json`),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  const { render } = (await import(pathToFileURL(join(root, ssrBundle)).href)) as { render: SsrRender };

  return createDocumentRenderer({
    template: () => template,
    ssr: () => render,
    ...(manifest ? { preloads: assetPreloads(manifest, { base: baseOf(template, manifest) }) } : {}),
    // The built index.html names every hashed asset: it changes exactly when the assets do.
    version: createHash('sha256').update(template).digest('hex').slice(0, 12),
  });
}

/** The parsed `text`, or `undefined` — which `parseManifest` then rejects with its message. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
