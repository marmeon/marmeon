import { escapeHtml } from '@marmeon/core';
import type { PageObject } from '@marmeon/http';
import { pageName } from '@marmeon/http/internal';

/** One chunk of Vite's `manifest.json` — the fields the server reads. */
export interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

/** Vite's `manifest.json`: chunks by their source path (`modules/demo/views/Home.tsx`). */
export type ViteManifest = Record<string, ManifestChunk>;

/**
 * What a document needs fetched early. `as: 'script'` is a module (`rel="modulepreload"`), the others `rel="preload"`;
 * the shape a `Link` header would reuse.
 */
export interface Preload {
  readonly href: string;
  readonly as: 'script' | 'font' | 'style';
}

/** The preloads of an app's build, computed once. */
export interface AssetPreloads {
  /** The entry's own chunks — which `index.html` already names. */
  readonly initial: readonly Preload[];
  /** The page's chunk, the chunks it imports, its layers' and tab sync — and the loading of deferred props, when it has some; without what `initial` has. */
  forPage(page: Pick<PageObject, 'component' | 'layers' | 'deferredProps' | 'streamedProps'>): readonly Preload[];
  /**
   * The stylesheets of the page's chunk, its layers' and everything they import statically — which `index.html` does not
   * link, because it names only the entry's. Each once, in the order the modules would apply them, without the entry's own.
   */
  stylesFor(page: Pick<PageObject, 'component' | 'layers'>): readonly string[];
}

/**
 * The chunk `createMarmeonApp` awaits before hydrating (`loadTabSync` in `@marmeon/http/client`). `history-fallback` is
 * left out on purpose: it loads only without the Navigation API.
 */
const TAB_SYNC = /(?:^|\/)(?:@marmeon|packages)\/http\/dist\/client\/features\/tab-sync\.js$/;

/** The chunk that asks for a page's deferred groups: the core fetches it when a page that carries some arrives, so the document names it early. */
const PROP_LOADER = /(?:^|\/)(?:@marmeon|packages)\/http\/dist\/client\/prop-loader\.js$/;

/** Whether `/${file}` parses to that very path on the page's origin — no other host, no dot segments, no query or fragment, no escapes that change it. */
function staysOnOrigin(file: string): boolean {
  try {
    const url = new URL(`/${file}`, 'http://h/');
    return url.host === 'h' && decodeURIComponent(url.pathname) === `/${file}`;
  } catch {
    return false;
  }
}

/** The manifest `json` parsed from `where` (named in the message), or a thrown error when it is no Vite manifest. */
export function parseManifest(json: unknown, where: string): ViteManifest {
  const invalid = () => new Error(`${where} is not a Vite manifest — run \`marmeon build\` again.`);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw invalid();
  for (const chunk of Object.values(json)) {
    if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) throw invalid();
    const { file, imports, isEntry, css } = chunk as Record<string, unknown>;
    // `file` and every `css` entry become the href of a tag that carries the response's nonce: each must name exactly that path on this origin.
    if (typeof file !== 'string' || !staysOnOrigin(file)) throw invalid();
    if (isEntry !== undefined && typeof isEntry !== 'boolean') throw invalid();
    if (imports !== undefined && !(Array.isArray(imports) && imports.every((item) => typeof item === 'string'))) throw invalid();
    if (css !== undefined && !(Array.isArray(css) && css.every((item) => typeof item === 'string' && staysOnOrigin(item)))) throw invalid();
  }
  return json as ViteManifest;
}

/** The chunks at `keys` and everything they import statically, depth first, each once. */
function closure(manifest: ViteManifest, keys: Iterable<string>, seen = new Set<string>()): Set<string> {
  for (const key of keys) {
    // Own keys only: an import named `toString` is no chunk.
    const chunk = Object.hasOwn(manifest, key) ? manifest[key] : undefined;
    if (!chunk || seen.has(key)) continue;
    seen.add(key);
    closure(manifest, chunk.imports ?? [], seen);
  }
  return seen;
}

/**
 * The stylesheets of the chunks at `keys` and of what they import statically, each once, an import's before the
 * importer's own: the order in which the modules evaluate, hence the order their CSS would apply if the chunk loaded.
 */
function stylesOf(manifest: ViteManifest, keys: Iterable<string>, seen = new Set<string>(), found: string[] = []): string[] {
  for (const key of keys) {
    const chunk = Object.hasOwn(manifest, key) ? manifest[key] : undefined;
    if (!chunk || seen.has(key)) continue;
    seen.add(key);
    stylesOf(manifest, chunk.imports ?? [], seen, found);
    found.push(...(chunk.css ?? []));
  }
  return found;
}

/** `base` as the build wrote it: `/`, or an `http(s)` URL that ends in `/` and carries no credentials, query or fragment. `@marmeon/vite` applies the same rule when it builds; change both together. */
function isBase(base: string): boolean {
  if (base === '/') return true;
  try {
    const url = new URL(base);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.href === base && url.pathname.endsWith('/') && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * The `base` the app was built with, read from the built `index.html`: the `src` of the module script that loads the entry
 * chunk, without that chunk's `file`. `/` when no script matches. Anything but `/` or an absolute URL stops the boot — the
 * server serves `dist/client` under `/`, so a path or a relative `base` would 404 every asset.
 */
export function baseOf(template: string, manifest: ViteManifest): string {
  const files = Object.values(manifest).filter((chunk) => chunk.isEntry).map((chunk) => chunk.file);
  for (const [tag] of template.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']?module\b/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = src?.[1] ?? src?.[2] ?? src?.[3];
    const file = value === undefined ? undefined : files.find((candidate) => value.endsWith(candidate));
    if (value === undefined || file === undefined) continue;
    const base = value.slice(0, -file.length);
    if (!isBase(base)) {
      throw new Error(`The build's \`base\` is '${base}', but the server serves dist/client under '/': build with \`base: '/'\`, or with an absolute URL where the assets are.`);
    }
    return base;
  }
  return '/';
}

/**
 * The preloads of every page and of tab sync in `manifest`, computed once. `base` is the build's (see `baseOf`): every href
 * starts with it; the manifest's own entries are checked as paths and stay on `base`.
 */
export function assetPreloads(manifest: ViteManifest, { base = '/' }: { base?: string } = {}): AssetPreloads {
  if (!isBase(base)) throw new Error(`assetPreloads: base must be '/' or an absolute URL ending in '/', not '${base}'.`);
  const href = (file: string): string => `${base}${new URL(`/${file}`, 'http://h/').pathname.slice(1)}`;
  const script = (key: string): Preload => ({ href: href(manifest[key]!.file), as: 'script' });
  const entries = Object.keys(manifest).filter((key) => manifest[key]!.isEntry);
  const initialKeys = new Set<string>();
  for (const entry of entries) closure(manifest, (manifest[entry]!.imports ?? []), initialKeys);
  const initial = [...closure(manifest, entries)].map(script);
  // The built index.html links these already.
  const entryStyles = new Set(stylesOf(manifest, entries));
  const pageStyles = new Map<string, readonly string[]>();
  const withoutInitial = (keys: string[]) => keys.filter((key) => Object.hasOwn(manifest, key) && !initialKeys.has(key) && !manifest[key]!.isEntry).map(script);

  const pages = new Map<string, readonly Preload[]>();
  for (const key of Object.keys(manifest)) {
    const name = pageName(key);
    if (name === undefined || name.includes('::')) continue;
    pages.set(name, withoutInitial([...closure(manifest, [key])]));
    pageStyles.set(name, stylesOf(manifest, [key]));
  }
  const tabSync = Object.keys(manifest).find((key) => TAB_SYNC.test(key));
  const boot = tabSync === undefined ? [] : withoutInitial([...closure(manifest, [tabSync])]);

  const propLoader = Object.keys(manifest).find((key) => PROP_LOADER.test(key));
  const deferred = propLoader === undefined ? [] : withoutInitial([...closure(manifest, [propLoader])]);

  return {
    initial,
    forPage(page) {
      const seen = new Set<string>();
      const result: Preload[] = [];
      for (const preload of [...(pages.get(page.component) ?? []), ...(page.layers ?? []).flatMap((layer) => pages.get(layer.component) ?? []), ...boot, ...(page.deferredProps || page.streamedProps ? deferred : [])]) {
        if (seen.has(preload.href)) continue;
        seen.add(preload.href);
        result.push(preload);
      }
      return result;
    },
    stylesFor(page) {
      const hrefs = [page.component, ...(page.layers ?? []).map((layer) => layer.component)].flatMap((component) => pageStyles.get(component) ?? []);
      return [...new Set(hrefs)].filter((file) => !entryStyles.has(file)).map(href);
    },
  };
}

/** `<link>` tags for `preloads`; scripts carry the response's `nonce` when it has one (a CSP with `'strict-dynamic'` needs it). */
export function preloadTags(preloads: readonly Preload[], nonce: string | undefined): string {
  return preloads
    .map(({ href, as }) => {
      const url = escapeHtml(href);
      if (as === 'script') return `<link rel="modulepreload" href="${url}" crossorigin${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''}>`;
      return `<link rel="preload" as="${as}" href="${url}" crossorigin>`;
    })
    .join('\n');
}

/**
 * `<link rel="stylesheet">` tags for `hrefs` — a page's own CSS, which the document would otherwise get only after the
 * page's chunk loads, so its first paint would be unstyled. They sit in the head after the template's own links, as the
 * entry's stylesheets do, so the layer order the entry's CSS declares first still holds. They carry the nonce like the
 * other tags the server writes.
 */
export function stylesheetTags(hrefs: readonly string[], nonce: string | undefined): string {
  return hrefs.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}" crossorigin${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''}>`).join('\n');
}
