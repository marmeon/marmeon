import { isDevelopment } from '@marmeon/http/client';

/** The `<meta>` and `<link>` fields of `<Head>`: their types, the merge of layout and page, and the tags they become. */

/** Open Graph: how a link to the page is previewed. See docs/seo.md#the-heads-fields. */
export interface OpenGraph {
  /** Default: the page's `title`, without the title template. */
  title?: string;
  /** Default: the page's `description`. */
  description?: string;
  type?: 'website' | 'article' | 'profile';
  /** Relative to the origin of `APP_URL`. */
  url?: string;
  siteName?: string;
  locale?: string;
  /** A URL (relative to the origin of `APP_URL`), or the URL with its size and text. */
  image?: string | { url: string; width?: number; height?: number; alt?: string };
  article?: { publishedTime?: string; modifiedTime?: string; authors?: string[]; tags?: string[] };
}

/** A Twitter/X card. See docs/seo.md#the-heads-fields. */
export interface TwitterCard {
  /** Set once, in the layout, and every page has it. */
  card?: 'summary' | 'summary_large_image';
  site?: string;
  creator?: string;
  /** Default: the page's `title`, without the title template. */
  title?: string;
  /** Default: the page's `description`. */
  description?: string;
  /** A URL, relative to the origin of `APP_URL`. */
  image?: string;
  imageAlt?: string;
}

/** A value JSON can hold: no `Date`, function, `bigint` or `undefined`. */
type JsonLdValue = string | number | boolean | null | readonly JsonLdValue[] | { readonly [key: string]: JsonLdValue };

/**
 * One block of structured data (schema.org): any JSON, with the `@type` every block needs. See docs/seo.md#structured-data.
 */
export type JsonLd = { readonly '@context'?: string; readonly '@type': string | readonly string[] } & { readonly [key: string]: JsonLdValue };

/** The fields of `<Head>` besides the title and its children. */
export interface HeadFields {
  /** The page's summary for search results. */
  description?: string;
  /** The page's address when several lead to it; relative to the origin of `APP_URL`. */
  canonical?: string;
  /** What crawlers may do with the page; a part left out is not said. */
  robots?: { index?: boolean; follow?: boolean };
  openGraph?: OpenGraph;
  twitter?: TwitterCard;
  /** Structured data for search engines; the blocks of a layout and its page are all written, in render order. */
  jsonLd?: JsonLd | readonly JsonLd[];
}

/** What one `<Head>` sets: its title and fields. */
export type HeadEntry = HeadFields & { title?: string };

/**
 * A `<meta>`, `<link>` or JSON-LD `<script>` the fields stand for. `key` names it among the others, so the browser can update
 * it in place. A script carries its `json` (what it holds, serialized by whoever writes it) instead of an attribute.
 */
export interface HeadTag {
  readonly element: 'meta' | 'link' | 'script';
  readonly key: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly json?: JsonLd;
}

function blocksOf(jsonLd: JsonLd | readonly JsonLd[] | undefined): readonly JsonLd[] {
  return jsonLd === undefined ? [] : Array.isArray(jsonLd) ? (jsonLd as readonly JsonLd[]) : [jsonLd as JsonLd];
}

/** The languages of a localized page: its own locale, and every locale's path (`PageObject.alternates`, with `x-default`). */
export interface HeadLanguages {
  readonly locale: string;
  readonly paths: Readonly<Record<string, string>>;
}

/** The languages a page names, or undefined when it is not localized — only the server's `alternates` make a page one. */
export function languagesOf(page: { locale?: string; alternates?: Readonly<Record<string, string>> }): HeadLanguages | undefined {
  return page.locale !== undefined && page.alternates !== undefined ? { locale: page.locale, paths: page.alternates } : undefined;
}

function defined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined)) as Partial<T>;
}

/** The `<Head>`s in render order as one: the last one sets a simple field, an object merges key by key. */
export function mergeHead(entries: readonly HeadEntry[]): HeadEntry {
  const merged: HeadEntry = {};
  const blocks: JsonLd[] = [];
  for (const { title, description, canonical, robots, openGraph, twitter, jsonLd } of entries) {
    if (title !== undefined) merged.title = title;
    if (description !== undefined) merged.description = description;
    if (canonical !== undefined) merged.canonical = canonical;
    if (robots) merged.robots = { ...merged.robots, ...defined(robots) };
    if (openGraph) merged.openGraph = { ...merged.openGraph, ...defined(openGraph) };
    if (twitter) merged.twitter = { ...merged.twitter, ...defined(twitter) };
    blocks.push(...blocksOf(jsonLd));
  }
  if (blocks.length > 0) merged.jsonLd = blocks;
  return merged;
}

/**
 * A URL as the head states it: made absolute against the origin of `base` (the server: `APP_URL`, never the request; the browser: its
 * origin), `http(s)` only. Anything else is dropped, with `warn` saying why (development).
 */
export function absoluteUrl(value: string, base: string | undefined, warn?: (message: string) => void): string | undefined {
  const drop = (why: string) => {
    warn?.(`[marmeon] <Head> dropped "${value}": ${why}`);
    return undefined;
  };
  let origin: string | undefined;
  try {
    origin = base === undefined ? undefined : new URL(base).origin;
  } catch {
    return drop(`the app's URL (APP_URL) "${base}" is not a URL.`);
  }
  try {
    // Against the origin, not `base` itself: an `APP_URL` with a path would otherwise turn `a` into `/shop/a` on one side only.
    const url = new URL(value, origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return drop('only http(s) URLs belong in the head.');
    // `//host/x` and `/\host/x` have no scheme but name another host: a path stays on the app's origin.
    if (!/^[a-z][a-z\d+.-]*:/i.test(value.trim()) && url.origin !== origin) return drop("a path without a scheme must stay on the app's own origin.");
    return url.href;
  } catch {
    return drop(origin === undefined ? "it is relative and the app's URL (APP_URL) is not set." : 'it is not a URL.');
  }
}

/**
 * The tags for the merged fields of a page, in the order they are written. A localized page (`languages`) also names each of
 * its languages with `hreflang` and `x-default`, is its own `canonical` unless a `<Head>` says otherwise, and tells Open Graph
 * its `locale` and the `locale:alternate`s.
 */
export function headTags(head: HeadEntry, base: string | undefined, warn?: (message: string) => void, languages?: HeadLanguages): HeadTag[] {
  const tags: HeadTag[] = [];
  const counts = new Map<string, number>();
  const add = (element: 'meta' | 'link', label: string, name: string, value: string | number | undefined, content = 'content') => {
    if (value === undefined || value === '') return;
    const key = `${label}:${name}`;
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    tags.push({ element, key: seen === 0 ? key : `${key}#${seen}`, attributes: [[label, name], [content, String(value)]] });
  };
  const url = (value: string | undefined) => (value === undefined ? undefined : absoluteUrl(value, base, warn));
  const { title, description, canonical, robots, openGraph: og, twitter } = head;

  add('meta', 'name', 'description', description);
  // All the languages or none, with one warning: an address that fails (no `APP_URL` on the server) fails them all. The query is
  // left off — it may only track — so a page whose query selects it sets its own `canonical`.
  let hrefs: Map<string, string> | undefined;
  if (languages) {
    hrefs = new Map();
    for (const [locale, path] of Object.entries(languages.paths)) {
      const href = absoluteUrl(path.replace(/\?.*$/s, ''), base, warn);
      if (href === undefined) {
        hrefs = undefined;
        break;
      }
      hrefs.set(locale, href);
    }
  }
  add('link', 'rel', 'canonical', canonical !== undefined ? url(canonical) : languages && hrefs?.get(languages.locale), 'href');
  if (robots) {
    const parts = [robots.index === undefined ? '' : robots.index ? 'index' : 'noindex', robots.follow === undefined ? '' : robots.follow ? 'follow' : 'nofollow'];
    add('meta', 'name', 'robots', parts.filter(Boolean).join(', '));
  }
  if (og) {
    const image = typeof og.image === 'string' ? { url: og.image } : og.image;
    add('meta', 'property', 'og:title', og.title ?? title);
    add('meta', 'property', 'og:description', og.description ?? description);
    add('meta', 'property', 'og:type', og.type);
    add('meta', 'property', 'og:url', url(og.url));
    add('meta', 'property', 'og:site_name', og.siteName);
    add('meta', 'property', 'og:locale', og.locale ?? (languages && languages.locale.replaceAll('-', '_')));
    if (languages) {
      for (const locale of Object.keys(languages.paths)) {
        if (locale !== 'x-default' && locale !== languages.locale) add('meta', 'property', 'og:locale:alternate', locale.replaceAll('-', '_'));
      }
    }
    const imageUrl = url(image?.url);
    add('meta', 'property', 'og:image', imageUrl);
    if (imageUrl !== undefined) {
      add('meta', 'property', 'og:image:width', image && 'width' in image ? image.width : undefined);
      add('meta', 'property', 'og:image:height', image && 'height' in image ? image.height : undefined);
      add('meta', 'property', 'og:image:alt', image && 'alt' in image ? image.alt : undefined);
    }
    const { publishedTime, modifiedTime, authors, tags: labels } = og.article ?? {};
    add('meta', 'property', 'article:published_time', publishedTime);
    add('meta', 'property', 'article:modified_time', modifiedTime);
    for (const author of authors ?? []) add('meta', 'property', 'article:author', author);
    for (const label of labels ?? []) add('meta', 'property', 'article:tag', label);
  }
  if (twitter) {
    add('meta', 'name', 'twitter:card', twitter.card);
    add('meta', 'name', 'twitter:site', twitter.site);
    add('meta', 'name', 'twitter:creator', twitter.creator);
    add('meta', 'name', 'twitter:title', twitter.title ?? title);
    add('meta', 'name', 'twitter:description', twitter.description ?? description);
    add('meta', 'name', 'twitter:image', url(twitter.image));
    add('meta', 'name', 'twitter:image:alt', twitter.imageAlt);
  }
  if (hrefs) {
    for (const [locale, href] of hrefs) {
      tags.push({ element: 'link', key: `alternate:${locale}`, attributes: [['rel', 'alternate'], ['hreflang', locale], ['href', href]] });
    }
  }
  // A block that cannot be serialized (a cycle, a `bigint`) is an app's bug: development names it, production leaves it out.
  blocksOf(head.jsonLd).forEach((block, index) => {
    try {
      JSON.stringify(block);
    } catch (cause) {
      if (!isDevelopment()) return;
      throw new Error(`[marmeon] <Head jsonLd> block ${index} (@type ${JSON.stringify(block['@type'])}) is not JSON: ${(cause as Error).message}`, { cause });
    }
    tags.push({ element: 'script', key: `jsonld:${index}`, attributes: [['type', 'application/ld+json']], json: block });
  });
  return tags;
}

/** The tags the languages stand for: what the server wrote for them is the registry's, whether or not a `<Head>` ever mounts. */
const SERVER_LANGUAGE_TAGS = ['link[rel="canonical"]', 'link[rel="alternate"][hreflang]'].map((selector) => `${selector}[data-marmeon-head="ssr"]`).join(',');

/**
 * The browser's `<Head>`s (layouts and page): the merged fields are kept as elements in `document.head`, updated in place
 * when a navigation changes them and removed once no `<Head>` stands for them. An adapter's `<Head>` takes an `order()` when
 * it mounts, `set()`s its entry and `delete()`s it when it unmounts.
 */
export class HeadRegistry {
  readonly #entries = new Map<number, HeadEntry>();
  readonly #elements = new Map<string, HTMLElement>();
  readonly #origin: string | undefined;
  readonly #warn: ((message: string) => void) | undefined;
  #next = 0;
  #pending = false;
  #languages: HeadLanguages | undefined;
  #took = false;

  /** `origin`: the app's (`APP_URL`), as the server resolved the head's URLs — else the browser's. `warn`: development only. */
  constructor(origin?: string, warn?: (message: string) => void) {
    this.#origin = origin;
    this.#warn = warn;
  }

  /** The languages of the page shown, `undefined` for a page that is not localized: a navigation sets them again. */
  setLanguages(languages: HeadLanguages | undefined): void {
    this.#languages = languages;
    this.#apply();
  }

  /** A number in render order — taken once, when a head component mounts. */
  order(): number {
    return this.#next++;
  }

  set(order: number, entry: HeadEntry): void {
    this.#entries.set(order, entry);
    this.#apply();
  }

  /** Applied a moment later: a navigation's `<Head>` that replaces this one `set()`s first, so the elements stay. */
  delete(order: number): void {
    if (!this.#entries.delete(order) || this.#pending) return;
    this.#pending = true;
    queueMicrotask(() => {
      this.#pending = false;
      this.#apply();
    });
  }

  /** The text of a JSON-LD script, set as `textContent` (no HTML parser). False when a Trusted Types policy refuses it. */
  #writeJson(element: HTMLElement, json: JsonLd): boolean {
    const text = JSON.stringify(json);
    if (element.textContent === text) return true;
    try {
      element.textContent = text;
      return true;
    } catch (cause) {
      if (isDevelopment()) {
        this.#warn?.(
          `[marmeon] <Head jsonLd> (@type ${JSON.stringify(json['@type'])}) was removed: the page's Content-Security-Policy (require-trusted-types-for) does not allow setting a script's text (${(cause as Error).message}).`,
        );
      }
      return false;
    }
  }

  #apply(): void {
    // The server's canonical and hreflang are this registry's from now on — also on a page without a `<Head>`, which would never
    // take them over. The other fields stay until a `<Head>` hydrates and replaces them (it may be behind a `<Suspense>`).
    if (!this.#took) {
      this.#took = true;
      for (const stale of document.head.querySelectorAll(SERVER_LANGUAGE_TAGS)) stale.remove();
    }
    const sorted = [...this.#entries].sort(([a], [b]) => a - b).map(([, entry]) => entry);
    const wanted = new Map(headTags(mergeHead(sorted), this.#origin ?? location.origin, this.#warn, this.#languages).map((tag) => [tag.key, tag]));
    for (const [key, element] of this.#elements) {
      if (wanted.has(key)) continue;
      element.remove();
      this.#elements.delete(key);
    }
    for (const [key, { element: name, attributes, json }] of wanted) {
      let element = this.#elements.get(key);
      const created = !element;
      if (!element) {
        element = document.createElement(name);
        element.setAttribute('data-marmeon-head', 'meta');
      }
      for (const [attribute, value] of attributes) if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
      if (json !== undefined && !this.#writeJson(element, json)) {
        // A Trusted Types policy refused the text: the block is left out.
        element.remove();
        this.#elements.delete(key);
        continue;
      }
      if (created) {
        document.head.append(element);
        this.#elements.set(key, element);
      }
    }
  }
}
