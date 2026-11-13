import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isNamespace, withCode } from '@marmeon/core/internal';
import type { SsrRender } from '@marmeon/http';
import { packageTemplate } from './documents.ts';
import { assetPreloads, baseOf, parseManifest, type ViteManifest } from './preloads.ts';
import { createDocumentRenderer, type EntryDocumentOptions, type PageRenderer } from './render.ts';

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
  // Checked even without a manifest: a build whose base the server cannot serve would 404 every asset.
  const base = baseOf(template, manifest);
  const { render } = (await import(pathToFileURL(join(root, ssrBundle)).href)) as { render: SsrRender };

  // Without package entries this file is absent: one document, preloaded from every entry of the manifest.
  const entries = await readEntries(join(root, clientDir, ENTRIES_FILE), `${clientDir}/${ENTRIES_FILE}`, manifest);
  const packages = new Map<string, EntryDocumentOptions>();
  const appEntry = entries === undefined ? undefined : 'index.html';
  if (entries !== undefined) {
    if (!Object.hasOwn(manifest!, 'index.html')) throw entryError(`${clientDir}/.vite/manifest.json has no chunk for index.html.`);
    for (const [namespace, client] of Object.entries(entries.entries)) {
      const file = join(root, dirname(ssrBundle), `ssr-${namespace}.js`);
      const found = await stat(file).then((info) => info.isFile(), () => false);
      if (!found) throw entryError(`${join(dirname(ssrBundle), `ssr-${namespace}.js`)} is missing for the package entry "${namespace}" — run \`marmeon build\` again.`);
      const { render: packageRender } = (await import(pathToFileURL(file).href)) as { render?: unknown };
      if (typeof packageRender !== 'function') throw entryError(`${join(dirname(ssrBundle), `ssr-${namespace}.js`)} does not export \`render\`.`);
      const pages = Object.fromEntries(Object.entries(entries.pages).filter(([view]) => view.startsWith(`${namespace}::`)));
      const preloads = assetPreloads(manifest!, { base, entry: client, pages });
      const document = packageTemplate({
        script: preloads.initial[0]!.href,
        preloads: preloads.initial.slice(1).map((preload) => preload.href),
        stylesheets: preloads.entryStylesheets,
      });
      packages.set(namespace, {
        template: () => document,
        ssr: () => packageRender as SsrRender,
        preloads,
        version: createHash('sha256').update(document).digest('hex').slice(0, 12),
      });
    }
  }

  return createDocumentRenderer({
    template: () => template,
    ssr: () => render,
    ...(manifest ? { preloads: assetPreloads(manifest, { base, ...(appEntry !== undefined ? { entry: appEntry } : {}) }) } : {}),
    // The built index.html names every hashed asset: it changes exactly when the assets do.
    version: createHash('sha256').update(template).digest('hex').slice(0, 12),
    ...(entries !== undefined ? { packages } : {}),
  });
}

/** Where the build lists the package entries and pages, below the client directory. */
const ENTRIES_FILE = '.vite/marmeon-entries.json';

function entryError(message: string): Error {
  return new Error(withCode('H16', message));
}

interface Entries {
  readonly entries: Readonly<Record<string, string>>;
  readonly pages: Readonly<Record<string, string>>;
}

/**
 * The package entries the build recorded, or `undefined` for a build without any. Anything but the exact format stops the boot: an
 * unknown `format`, a namespace that is none, a key the manifest lacks.
 */
async function readEntries(path: string, where: string, manifest: ViteManifest | undefined): Promise<Entries | undefined> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const invalid = () => entryError(`${where} is not a list of package entries this server reads — run \`marmeon build\` again with the same version of Marmeon.`);
  const json = parseJson(text);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw invalid();
  const { format, entries, pages } = json as Record<string, unknown>;
  if (format !== 1) throw invalid();
  if (!isRecord(entries) || !isRecord(pages)) throw invalid();
  if (!manifest) throw entryError(`${where} needs the build's .vite/manifest.json, which is missing.`);
  const clients: Record<string, string> = {};
  for (const [namespace, entry] of Object.entries(entries)) {
    const client = isRecord(entry) ? entry.client : undefined;
    if (!isNamespace(namespace) || typeof client !== 'string') throw invalid();
    if (!Object.hasOwn(manifest, client)) throw entryError(`${where} names a client entry for "${namespace}" that .vite/manifest.json does not have — run \`marmeon build\` again.`);
    clients[namespace] = client;
  }
  const keys: Record<string, string> = {};
  for (const [view, key] of Object.entries(pages)) {
    const at = view.indexOf('::');
    if (at === -1 || typeof key !== 'string' || !Object.hasOwn(clients, view.slice(0, at))) throw invalid();
    if (!Object.hasOwn(manifest, key)) throw entryError(`${where} lists a page that .vite/manifest.json does not have — run \`marmeon build\` again.`);
    keys[view] = key;
  }
  return { entries: clients, pages: keys };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parsed `text`, or `undefined` — which `parseManifest` then rejects with its message. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
