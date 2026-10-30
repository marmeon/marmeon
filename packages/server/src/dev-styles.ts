import { escapeHtml } from '@marmeon/core';
import { CSP_NONCE_PLACEHOLDER } from '@marmeon/core/internal';
import type { DevEnvironment } from 'vite';

/** A stylesheet the client entry imports: the URL the browser asks for, and Vite's module id for it. */
export interface DevStylesheet {
  /** The browser URL as Vite writes it, e.g. `/styles/app.css` or `/@id/__x00__virtual:marmeon/fonts.css`. */
  readonly href: string;
  /** Vite's module id — the one its client's `updateStyle` uses. */
  readonly id: string;
}

export interface EntryStylesheetsOptions {
  /** The server's `base` (`'/'` or `'/app/'`). */
  readonly base: string;
  /** `parseAst` of the app's Vite. */
  readonly parse: (code: string) => { body: readonly unknown[] };
  /** The static import specifiers of each transformed module; Vite replaces a module's result when it changes. */
  readonly imports: WeakMap<object, readonly string[]>;
}

interface Target {
  /** What the browser asks for (the base kept, `import` and `t=` dropped). */
  readonly href: string;
  /** What Vite's module graph knows it as (base stripped, `/@id/` unwrapped). */
  readonly url: string;
}

const STYLESHEET = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/;
// Imports that give JS (a string, a URL, a worker), not a style.
const NOT_A_STYLE = new Set(['inline', 'raw', 'url', 'worker', 'sharedworker']);

/**
 * The target of an import specifier, or `undefined` for what must not be followed or linked: another origin, Vite's client, and
 * pre-bundled dependencies (transforming one would wait on the optimizer, so CSS a dependency imports from its own JS is not linked).
 */
export function requestUrl(spec: string, base: string): Target | undefined {
  // The tag carries the response's nonce: only a path on this origin may be linked. `//host`, `/\host` and `https://…` parse to another host.
  if (!spec.startsWith('/') || new URL(spec, 'http://h/').host !== 'h') return undefined;
  const queryAt = spec.indexOf('?');
  const path = queryAt === -1 ? spec : spec.slice(0, queryAt);
  const params = (queryAt === -1 ? '' : spec.slice(queryAt + 1)).split('&').filter((param) => param !== '' && param !== 'import' && !/^t=\d+$/.test(param));
  const href = params.length === 0 ? path : `${path}?${params.join('&')}`;
  let url = href;
  if (base !== '/') {
    if (!path.startsWith(base)) return undefined;
    url = `/${href.slice(base.length)}`;
  }
  if (url.startsWith('/@vite/') || url.startsWith('/node_modules/.vite/')) return undefined;
  if (url.startsWith('/@id/')) url = url.slice('/@id/'.length).replace('__x00__', '\0');
  return { href, url };
}

/** Whether Vite serves `url` as a stylesheet a `<link>` can stand in for (not a CSS module, not `?inline` and the like). */
export function isStylesheet(url: string): boolean {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  if (!STYLESHEET.test(path) || /\.module\.[^./]+$/.test(path)) return false;
  const params = queryAt === -1 ? [] : url.slice(queryAt + 1).split('&');
  return !params.some((param) => NOT_A_STYLE.has(param.split('=')[0]!));
}

function withDirect(url: string): string {
  return url.includes('?') ? `${url}&direct` : `${url}?direct`;
}

function staticImports(code: string, parse: EntryStylesheetsOptions['parse']): string[] {
  const specs: string[] = [];
  for (const node of parse(code).body as { type: string; source?: { value?: unknown } | null }[]) {
    if (node.type !== 'ImportDeclaration' && node.type !== 'ExportAllDeclaration' && node.type !== 'ExportNamedDeclaration') continue;
    if (typeof node.source?.value === 'string') specs.push(node.source.value);
  }
  return specs;
}

/**
 * The stylesheets the client entry imports statically, in the order Vite's client would insert them. Only the entry's static
 * imports count (a lazily loaded module's CSS arrives with it, as in production). Never rejects: a module that fails to
 * transform or parse is left out, and Vite's overlay reports it in the browser.
 */
export async function entryStylesheets(environment: DevEnvironment, entryUrl: string, { base, parse, imports }: EntryStylesheetsOptions): Promise<DevStylesheet[]> {
  const seen = new Set<string>([entryUrl]);
  const edges = new Map<string, Target[]>();
  const sheets = new Map<string, DevStylesheet>();

  const visit = async (target: Target): Promise<void> => {
    try {
      if (isStylesheet(target.url)) {
        // A link Vite cannot serve as a stylesheet (a syntax error, a virtual module that loads only its exact id) would leave
        // the page without the style: Vite skips its own `<style>` for an id that has a link. Without a tag, Vite's client injects its `<style>`.
        await environment.transformRequest(withDirect(target.url));
        const id = (await environment.moduleGraph.getModuleByUrl(target.url))?.id;
        if (id) sheets.set(target.url, { href: target.href, id });
        return;
      }
      const result = await environment.transformRequest(target.url);
      if (!result) return;
      let specs = imports.get(result);
      if (!specs) {
        specs = staticImports(result.code, parse);
        imports.set(result, specs);
      }
      const children: Target[] = [];
      for (const spec of specs) {
        const child = requestUrl(spec, base);
        if (child) children.push(child);
      }
      edges.set(target.url, children);
      await Promise.all(
        children.filter((child) => !seen.has(child.url) && seen.add(child.url)).map((child) => visit(child)),
      );
    } catch {
      // Left out, with its subtree.
    }
  };

  const entry: Target = { href: entryUrl, url: entryUrl };
  await visit(entry);

  // ESM evaluation order: depth first, in import order, each module once.
  const ordered: DevStylesheet[] = [];
  const done = new Set<string>();
  const walk = (url: string): void => {
    for (const child of edges.get(url) ?? []) {
      if (done.has(child.url)) continue;
      done.add(child.url);
      const sheet = sheets.get(child.url);
      if (sheet) ordered.push(sheet);
      else walk(child.url);
    }
  };
  done.add(entry.url);
  walk(entry.url);
  return ordered;
}

/** The `<link>` tags for `sheets` (`''` for none), with the nonce placeholder `withNonce` replaces. */
export function devStyleTags(sheets: readonly DevStylesheet[]): string {
  if (sheets.length === 0) return '';
  let restore = false;
  const tags = sheets.map(({ href, id }) => {
    // `data-vite-dev-id` makes Vite's client adopt the link: no duplicate `<style>`, and an edit reaches it through `css-update`.
    // HTML cannot carry NUL (a virtual id): the id travels as JSON and the script below sets the attribute before Vite's client runs.
    const unsafe = /[\0\r]/.test(id);
    restore ||= unsafe;
    const attribute = unsafe ? `data-marmeon-dev-id="${escapeHtml(JSON.stringify(id))}"` : `data-vite-dev-id="${escapeHtml(id)}"`;
    return `<link rel="stylesheet" href="${escapeHtml(href)}" ${attribute} nonce="${CSP_NONCE_PLACEHOLDER}">`;
  });
  if (restore) {
    tags.push(
      `<script nonce="${CSP_NONCE_PLACEHOLDER}">for(const l of document.querySelectorAll('link[data-marmeon-dev-id]'))l.setAttribute('data-vite-dev-id',JSON.parse(l.getAttribute('data-marmeon-dev-id')))</script>`,
    );
  }
  return tags.join('\n');
}
