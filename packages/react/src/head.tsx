import { defaultTitle, scriptJson, type TitleRegistry } from '@marmeon/http/client/adapter';
import type { TitleTemplate } from '@marmeon/http/client';
import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { headTags, mergeHead, type HeadEntry, type HeadFields, type HeadLanguages, type HeadRegistry } from './head-fields.ts';

export { defaultTitle } from '@marmeon/http/client/adapter';
export type { TitleTemplate } from '@marmeon/http/client';
export type { JsonLd, OpenGraph, TwitterCard } from './head-fields.ts';

/** Server rendering: where `<Head>`s record themselves for the document head. */
export interface HeadCollector {
  /** The `<Head>`s in render order. */
  readonly entries: (HeadEntry & { tags: ReactElement[] })[];
  /** Set once the head is rendered: a `<Head>` after that (in a Suspense boundary that streams in later) misses it. */
  sealed: boolean;
  /** Called for such a late `<Head>` (development: a warning). */
  onLate?: (title: string | undefined) => void;
}

interface HeadContextValue {
  template: TitleTemplate;
  /** Only while rendering on the server: `<Head>` records itself here. */
  collector?: HeadCollector;
  /** Only in the browser: who sets the document title. */
  titles?: TitleRegistry;
  /** Only in the browser: who keeps the fields' tags. */
  fields?: HeadRegistry;
}

export const HeadContext = createContext<HeadContextValue>({ template: defaultTitle });

export interface HeadProps extends HeadFields {
  /** Page title, passed through the app's title template. */
  title?: string;
  /**
   * `<meta>`, `<link>`, `<script>` and `<style>` elements for this page. In the browser only string, number and `true` props become
   * attributes (never `on*`), a string child of a script or style is its text, and a script or style gets the page's nonce. The
   * server's elements are kept when the page hydrates. See docs/pages.md#the-document-head.
   */
  children?: ReactNode;
}

const MARKER = 'data-marmeon-head';

/**
 * The page's title and meta tags. Rendered on the server into the document head,
 * kept up to date on client-side navigations. See docs/pages.md#the-document-head.
 */
export function Head(props: HeadProps) {
  const island = useContext(IslandHeadContext);
  if (island === null) return <PageHead {...props} />;
  // An island renders after the document head went out (streamed) — and beside a page that has its own.
  // Development only: a bundler replaces `process.env.NODE_ENV`, and a production bundle drops the message.
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    throw new Error(`[marmeon:R13] <Head> in island [${island}] — islands cannot change the document head; set it on the page.`);
  }
  return null;
}

/**
 * The component of the island around (its view's name) — `<Head>` refuses to render there. Null outside an island.
 * @internal
 */
export const IslandHeadContext = createContext<string | null>(null);

function PageHead({ title, children, ...fields }: HeadProps) {
  const { template, collector, titles, fields: registry } = useContext(HeadContext);
  const [order] = useState(() => titles?.order() ?? 0);
  const [fieldsOrder] = useState(() => registry?.order() ?? 0);
  const tags = Children.toArray(children).filter(isValidElement) as ReactElement[];

  if (collector) {
    // Server render: the last <Head> wins for the title (a page overrides its layout). After the head went out
    // (streaming), it is too late for this one — the browser adds its tags once it hydrates.
    if (collector.sealed) collector.onLate?.(title);
    else collector.entries.push({ title, ...fields, tags });
  }

  // A block JSON.stringify cannot write is reported where the head is built (`headTags`), with its @type.
  const { jsonLd, ...simple } = fields;
  let blocks: string | undefined;
  try {
    blocks = JSON.stringify(jsonLd);
  } catch {
    blocks = undefined;
  }
  const signature = JSON.stringify([tags.map((tag) => [tag.type, tag.props]), simple, blocks]);
  // `signature` stands in for `tags` and `fields`, whose identity changes on every render.
  useEffect(() => {
    // The tags written here are taken over from the server's where they equal them (a script that ran is not written again).
    // Only the server's title and the fields' tags (`ssr`) are removed here, before the title is set; the tags of other
    // `<Head>`s stay for them, and `sweepServerTags` removes the rest.
    const elements = tags.map(toDescription).filter((description): description is TagDescription => description !== null).map(adoptOrCreate).filter((element): element is HTMLElement => element !== null);
    for (const stale of document.head.querySelectorAll(`[${MARKER}="ssr"]`)) stale.remove();
    if (title !== undefined) {
      if (titles) titles.set(order, title);
      else document.title = template(title);
    }
    registry?.set(fieldsOrder, { title, ...fields });
    for (const element of elements) if (!element.isConnected) document.head.append(element);
    return () => {
      if (title !== undefined) titles?.delete(order);
      registry?.delete(fieldsOrder);
      for (const element of elements) element.remove();
    };
  }, [title, template, titles, order, registry, fieldsOrder, signature]);

  return null;
}

/**
 * Server: the collected head as HTML — title (escaped, through the template), the fields' tags and the `<Head>`s' own.
 * Without a `<Head title>`, the title is `template('')` (as on the client), or the template's own `<title>` when that is empty.
 * `languages`: those of a localized page, named by `hreflang`. `appUrl` is what a relative URL in the fields is resolved against — the app's configuration, never the request.
 */
export function renderHead(
  collector: HeadCollector,
  template: TitleTemplate,
  renderTag: (tag: ReactElement) => string,
  { appUrl, warn, nonce, languages }: { appUrl?: string; warn?: (message: string) => void; nonce?: string; languages?: HeadLanguages } = {},
): string {
  const { entries } = collector;
  const merged = mergeHead(entries);
  const text = template(merged.title ?? '');
  const title = text === '' ? '' : `<title ${MARKER}="ssr">${escapeHtml(text)}</title>`;
  const fields = headTags(merged, appUrl, warn, languages)
    .map(({ element, attributes, json }) => {
      if (json !== undefined) {
        // The text is `scriptJson` (`<` escaped), written as a string: never a React child, never `dangerouslySetInnerHTML`.
        // The nonce is no protection (a data block does not run): it only makes the element like the server's other scripts.
        const attribute = attributes.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
        return `<script${attribute}${nonce ? ` nonce="${escapeHtml(nonce)}"` : ''} ${MARKER}="ssr">${scriptJson(json)}</script>`;
      }
      return `<${element} ${attributes.map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ')} ${MARKER}="ssr"/>`;
    })
    .join('');
  return title + fields + entries.flatMap((entry) => entry.tags.map(renderTag)).join('');
}

export function createHeadCollector(onLate?: (title: string | undefined) => void): HeadCollector {
  return { entries: [], sealed: false, onLate };
}

/** The marker of the tags of `<Head>` the server wrote: the `<Head>` that renders them takes them over (the fields' own are `ssr`). */
const SERVER_TAG = 'ssr-tag';

/** `data-marmeon-head="ssr-tag"` on server-rendered tags, so the client can take them over. */
export function markServerTag(tag: ReactElement): ReactElement {
  return cloneElement(tag, { [MARKER]: SERVER_TAG } as Record<string, string>);
}

/** A tag of `<Head>` as the browser would have it: its attributes (strings only) and, for a script or style, its text. */
interface TagDescription {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly text: string | undefined;
}

const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = { className: 'class', htmlFor: 'for', httpEquiv: 'http-equiv', charSet: 'charset', acceptCharset: 'accept-charset' };
/** The attributes React writes as `name=""` for `true` and leaves out for `false`. */
const BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set(
  'allowfullscreen async autofocus autoplay controls default defer disabled disablepictureinpicture disableremoteplayback formnovalidate hidden loop nomodule novalidate open playsinline readonly required reversed scoped seamless itemscope inert capture download'.split(' '),
);
const NOT_ATTRIBUTES: ReadonlySet<string> = new Set(['children', 'nonce', 'suppressHydrationWarning', 'suppressContentEditableWarning', 'dangerouslySetInnerHTML', 'style']);

/**
 * The attributes React would write for the props, since the server's tag is compared with them. Only strings, numbers and the
 * booleans of boolean attributes (and of `data-*` and `aria-*`) become attributes: a function prop would otherwise be written as
 * the source of an inline handler, and an object as `[object Object]`. `on*` is never an attribute, and `nonce` is the page's (see
 * `pageNonce`), not the tag's.
 */
function toDescription(tag: ReactElement): TagDescription | null {
  if (typeof tag.type !== 'string') return null;
  const attributes = new Map<string, string>();
  const props = tag.props as Record<string, unknown>;
  for (const [prop, value] of Object.entries(props)) {
    if (NOT_ATTRIBUTES.has(prop) || /^on/i.test(prop)) continue;
    const name = (ATTRIBUTE_NAMES[prop] ?? prop).toLowerCase();
    if (/^(data|aria)-/.test(name) && typeof value === 'boolean') attributes.set(name, String(value));
    else if (BOOLEAN_ATTRIBUTES.has(name)) {
      if (value) attributes.set(name, (name === 'capture' || name === 'download') && typeof value === 'string' ? value : '');
    } else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) attributes.set(name, String(value));
  }
  // As React writes a script or style: only a single string is its text.
  const text = (tag.type === 'script' || tag.type === 'style') && typeof props.children === 'string' ? props.children : undefined;
  return { name: tag.type, attributes, text };
}

/** The text of a script or style as React writes it into the server's document (`</script` and `</style` cannot end the element). */
function serverText(name: string, text: string): string {
  if (name === 'script') return text.replace(/(<\/|<)(s)(cript)/gi, (_, prefix: string, letter: string, rest: string) => `${prefix}${letter === 's' ? '\\u0073' : '\\u0053'}${rest}`);
  return text.replace(/(<\/|<)(s)(tyle)/gi, (_, prefix: string, letter: string, rest: string) => `${prefix}${letter === 's' ? '\\73 ' : '\\53 '}${rest}`);
}

/** The CSP nonce of the page: the one its server-written scripts carry (the browser hides the attribute, `.nonce` keeps it). */
function pageNonce(): string | undefined {
  const script = document.querySelector<HTMLScriptElement>('script[nonce]');
  return script?.nonce || script?.getAttribute('nonce') || undefined;
}

function sameTag(element: Element, { name, attributes, text }: TagDescription): boolean {
  if (element.localName !== name) return false;
  const present = [...element.attributes].filter((attribute) => attribute.name !== MARKER && attribute.name !== 'nonce');
  if (present.length !== attributes.size || present.some((attribute) => attributes.get(attribute.name) !== attribute.value)) return false;
  return text === undefined || element.textContent === serverText(name, text);
}

/** The server's element for the tag, now the client's; else a new one — a script or style with the page's nonce. */
function adoptOrCreate(description: TagDescription): HTMLElement | null {
  const rendered = [...document.head.querySelectorAll<HTMLElement>(`[${MARKER}="${SERVER_TAG}"]`)].find((element) => sameTag(element, description));
  if (rendered) {
    rendered.setAttribute(MARKER, 'client');
    return rendered;
  }
  const element = document.createElement(description.name);
  for (const [name, value] of description.attributes) element.setAttribute(name, value);
  if (description.text !== undefined) {
    try {
      element.textContent = description.text;
    } catch {
      // A Trusted Types policy refuses a script's or style's text: the tag is left out.
      return null;
    }
  }
  if (description.name === 'script' || description.name === 'style') {
    const nonce = pageNonce();
    if (nonce) element.setAttribute('nonce', nonce);
  }
  element.setAttribute(MARKER, 'client');
  return element;
}

/**
 * Removes the tags of `<Head>` the server wrote and no `<Head>` took over. Called once the app has committed its next page: a
 * `<Head>` in a Suspense boundary may hydrate late, and until then its tags are the ones it takes over.
 * @internal
 */
export function sweepServerTags(): void {
  for (const stale of document.head.querySelectorAll(`[${MARKER}="${SERVER_TAG}"]`)) stale.remove();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
