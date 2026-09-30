import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, type ReactElement, type ReactNode } from 'react';

/** Turns a page's title into the document title, e.g. `(title) => title ? `${title} — Shop` : 'Shop'`. */
export type TitleTemplate = (title: string) => string;

export const defaultTitle: TitleTemplate = (title) => title;

interface HeadCollector {
  title: string | undefined;
  tags: ReactElement[];
}

interface HeadContextValue {
  template: TitleTemplate;
  /** Only while rendering on the server: `<Head>` records itself here. */
  collector?: HeadCollector;
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
  const { template, collector } = useContext(HeadContext);
  const tags = Children.toArray(children).filter(isValidElement) as ReactElement[];

  if (collector) {
    // Server render: the last <Head> wins for the title (a page overrides its layout).
    if (title !== undefined) collector.title = title;
    collector.tags.push(...tags);
  }

  const signature = JSON.stringify(tags.map((tag) => [tag.type, tag.props]));
  // `signature` stands in for `tags`, whose identity changes on every render.
  useEffect(() => {
    // Server-rendered tags (title included) hand over to the ones managed here — removed first,
    // so the title set next is not removed with them.
    for (const stale of document.head.querySelectorAll(`[${MARKER}="ssr"]`)) stale.remove();
    if (title !== undefined) document.title = template(title);
    const elements = tags.map(toElement).filter((element): element is HTMLElement => element !== null);
    for (const element of elements) document.head.append(element);
    return () => {
      for (const element of elements) element.remove();
    };
  }, [title, template, signature]);

  return null;
}

/** Server: the collected head as HTML — title (escaped, through the template) and tags. */
export function renderHead(collector: HeadCollector, template: TitleTemplate, renderTag: (tag: ReactElement) => string): string {
  const title = collector.title === undefined ? '' : `<title ${MARKER}="ssr">${escapeHtml(template(collector.title))}</title>`;
  return title + collector.tags.map(renderTag).join('');
}

export function createHeadCollector(): HeadCollector {
  return { title: undefined, tags: [] };
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
