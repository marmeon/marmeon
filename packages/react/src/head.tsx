import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';

/** Turns a page's title into the document title, e.g. `(title) => title ? `${title} — Shop` : 'Shop'`. */
export type TitleTemplate = (title: string) => string;

export const defaultTitle: TitleTemplate = (title) => title;

/** Server rendering: where `<Head>`s record themselves for the document head. */
export interface HeadCollector {
  /** The `<Head>`s in render order. */
  readonly entries: { title: string | undefined; tags: ReactElement[] }[];
  /** Set once the head is rendered: a `<Head>` after that (in a Suspense boundary that streams in later) misses it. */
  sealed: boolean;
  /** Called for such a late `<Head>` (development: a warning). */
  onLate?: (title: string | undefined) => void;
}

/**
 * The titles of the mounted `<Head>`s (layouts and page) — the one rendered last wins, like on the server.
 * When the page's goes away and nobody else has one, the document title falls back to `template('')`:
 * a page without `<Head title>` does not keep the title of the page before it.
 */
export class TitleRegistry {
  readonly #titles = new Map<number, string>();
  readonly #template: TitleTemplate;
  readonly #document: Pick<Document, 'title'>;
  #next = 0;

  constructor(template: TitleTemplate, doc: Pick<Document, 'title'> = document) {
    this.#template = template;
    this.#document = doc;
  }

  /** A number in render order — taken once, when a `<Head>` mounts. */
  order(): number {
    return this.#next++;
  }

  set(order: number, title: string): void {
    this.#titles.set(order, title);
    this.#apply();
  }

  delete(order: number): void {
    if (this.#titles.delete(order)) this.#apply();
  }

  #apply(): void {
    let last: number | undefined;
    for (const order of this.#titles.keys()) if (last === undefined || order > last) last = order;
    this.#document.title = this.#template(last === undefined ? '' : this.#titles.get(last)!);
  }
}

interface HeadContextValue {
  template: TitleTemplate;
  /** Only while rendering on the server: `<Head>` records itself here. */
  collector?: HeadCollector;
  /** Only in the browser: who sets the document title. */
  titles?: TitleRegistry;
}

export const HeadContext = createContext<HeadContextValue>({ template: defaultTitle });

export interface HeadProps {
  /** Page title, passed through the app's title template. */
  title?: string;
  /** `<meta>` and `<link>` elements for this page. */
  children?: ReactNode;
}

const MARKER = 'data-bespoke-head';

/**
 * The page's title and meta tags. Rendered on the server into the document head,
 * kept up to date on client-side navigations.
 *
 * ```tsx
 * <Head title={profile.name}>
 *   <meta name="description" content={profile.bio} />
 * </Head>
 * ```
 */
export function Head({ title, children }: HeadProps) {
  const { template, collector, titles } = useContext(HeadContext);
  const [order] = useState(() => titles?.order() ?? 0);
  const tags = Children.toArray(children).filter(isValidElement) as ReactElement[];

  if (collector) {
    // Server render: the last <Head> wins for the title (a page overrides its layout). After the head went out
    // (streaming), it is too late for this one — the browser adds its tags once it hydrates.
    if (collector.sealed) collector.onLate?.(title);
    else collector.entries.push({ title, tags });
  }

  const signature = JSON.stringify(tags.map((tag) => [tag.type, tag.props]));
  // `signature` stands in for `tags`, whose identity changes on every render.
  useEffect(() => {
    // Server-rendered tags (title included) hand over to the ones managed here — removed first,
    // so the title set next is not removed with them.
    for (const stale of document.head.querySelectorAll(`[${MARKER}="ssr"]`)) stale.remove();
    if (title !== undefined) {
      if (titles) titles.set(order, title);
      else document.title = template(title);
    }
    const elements = tags.map(toElement).filter((element): element is HTMLElement => element !== null);
    for (const element of elements) document.head.append(element);
    return () => {
      if (title !== undefined) titles?.delete(order);
      for (const element of elements) element.remove();
    };
  }, [title, template, titles, order, signature]);

  return null;
}

/**
 * Server: the collected head as HTML — title (escaped, through the template) and tags. Without a `<Head title>`,
 * the title is `template('')` (as on the client), or the template's own `<title>` when that is empty.
 */
export function renderHead(collector: HeadCollector, template: TitleTemplate, renderTag: (tag: ReactElement) => string): string {
  const { entries } = collector;
  const text = template(entries.findLast((entry) => entry.title !== undefined)?.title ?? '');
  const title = text === '' ? '' : `<title ${MARKER}="ssr">${escapeHtml(text)}</title>`;
  return title + entries.flatMap((entry) => entry.tags.map(renderTag)).join('');
}

export function createHeadCollector(onLate?: (title: string | undefined) => void): HeadCollector {
  return { entries: [], sealed: false, onLate };
}

/** `data-bespoke-head="ssr"` on server-rendered tags, so the client can take them over. */
export function markServerTag(tag: ReactElement): ReactElement {
  return cloneElement(tag, { [MARKER]: 'ssr' } as Record<string, string>);
}

function toElement(tag: ReactElement): HTMLElement | null {
  if (typeof tag.type !== 'string') return null;
  const element = document.createElement(tag.type);
  for (const [name, value] of Object.entries(tag.props as Record<string, unknown>)) {
    if (name === 'children' || value === undefined || value === null || value === false) continue;
    element.setAttribute(name === 'httpEquiv' ? 'http-equiv' : name === 'charSet' ? 'charset' : name, String(value));
  }
  element.setAttribute(MARKER, 'client');
  return element;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
