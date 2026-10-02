import { defaultTitle, type TitleRegistry, type TitleTemplate } from '@bespokecore/http/client';
import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';

export { defaultTitle } from '@bespokecore/http/client';
export type { TitleTemplate } from '@bespokecore/http/client';

/** Server rendering: where `<Head>`s record themselves for the document head. */
export interface HeadCollector {
  /** The `<Head>`s in render order. */
  readonly entries: { title: string | undefined; tags: ReactElement[] }[];
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
export function Head(props: HeadProps) {
  const island = useContext(IslandHeadContext);
  if (island === null) return <PageHead {...props} />;
  // An island renders after the document head went out (streamed, E49) — and beside a page that has its own.
  // Development only: a bundler replaces `process.env.NODE_ENV`, and a production bundle drops the message.
  if (process.env.NODE_ENV !== 'production') {
    throw new Error(`[bespoke:R13] <Head> in island [${island}] — islands cannot change the document head; set it on the page.`);
  }
  return null;
}

/**
 * The component of the island around (its view's name) — `<Head>` refuses to render there. Null outside an island.
 * @internal
 */
export const IslandHeadContext = createContext<string | null>(null);

function PageHead({ title, children }: HeadProps) {
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
