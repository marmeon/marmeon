import { pageQuery, queryUrl } from '@marmeon/http/client';
import type { PageObject, PaginationMeta } from '@marmeon/http/page';
import type { ReactNode } from 'react';
import { usePage } from './app.tsx';
import { Link } from './link.tsx';

/** What `<Pagination>` says — for screen readers too. */
export interface PaginationLabels {
  /** The name of the navigation (`aria-label`). */
  readonly navigation: string;
  readonly previous: string;
  readonly next: string;
  /** The name of a page's link: `Page 3`. */
  readonly page: (page: number) => string;
}

/** Its texts without `labels`: English. Every other language comes from the app's messages — `labels={{ next: t('next') }}`. */
const ENGLISH: PaginationLabels = { navigation: 'Pagination', previous: '‹ Previous', next: 'Next ›', page: (page) => `Page ${page}` };

export interface PaginationProps {
  meta: PaginationMeta;
  /** Pages shown on each side of the current one (default 2): `1 … 4 5 [6] 7 8 … 20`. */
  window?: number;
  /** The query field that carries the page (default `page` — what `pageQuery()` names it). */
  param?: string;
  /** Its texts in the page's language, from the app's messages (`useTranslation`): `labels={{ next: t('next') }}` — English without. */
  labels?: Partial<PaginationLabels>;
}

/**
 * Links to the pages of a list (`paginate()`'s `meta`). The links come from the page's parsed query (the route's schema, with
 * `pageQuery()` in it) — the rest of it stays (a filter, the sort, the page size) and the defaults stay out (`?page=1` is no
 * page's URL). Renders nothing for a single page.
 */
export function Pagination({ meta, window = 2, param = 'page', labels }: PaginationProps): ReactNode {
  const page = usePage();
  if (meta.lastPage <= 1) return null;
  const text: PaginationLabels = { ...ENGLISH, ...labels };
  const href = pageHref(page, param);
  const pages = pagesAround(meta.page, meta.lastPage, window);

  return (
    <nav aria-label={text.navigation}>
      {meta.page > 1 && (
        <Link href={href(meta.page - 1)} rel="prev">
          {text.previous}
        </Link>
      )}{' '}
      {pages.map((number, index) =>
        number === null ? (
          <span key={`gap-${index}`}> … </span>
        ) : number === meta.page ? (
          <strong key={number} aria-current="page">
            {' '}
            {number}{' '}
          </strong>
        ) : (
          <Link key={number} href={href(number)} aria-label={text.page(number)}>
            {' '}
            {number}{' '}
          </Link>
        ),
      )}{' '}
      {meta.page < meta.lastPage && (
        <Link href={href(meta.page + 1)} rel="next">
          {text.next}
        </Link>
      )}
    </nav>
  );
}

/** Development only: the pages warned about a query schema without the page's field (once each). */
let warned: Set<string> | undefined;

/**
 * The URL of page `number` of the page on screen: its parsed query with `param` set — from the schema, never by parsing the
 * address. A page whose route has no query schema keeps its query string as it is.
 */
function pageHref(page: Pick<PageObject, 'url' | 'component' | 'query' | 'queryDefaults'>, param: string): (number: number) => string {
  if (page.queryDefaults) {
    if ((process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && !Object.hasOwn(page.queryDefaults, param) && !(warned ??= new Set()).has(`${page.component} ${param}`)) {
      warned.add(`${page.component} ${param}`);
      console.warn(`[marmeon:R17] <Pagination param="${param}"> on ${page.component}, whose query schema has no "${param}" — its links would lead to the first page: spread pageQuery() into the route's query schema.`);
    }
    const query = pageQuery(page);
    return (number) => queryUrl(page, { ...query, [param]: number });
  }
  return (number) => {
    const target = new URL(page.url, 'http://marmeon.invalid');
    if (number === 1) target.searchParams.delete(param);
    else target.searchParams.set(param, String(number));
    return target.pathname + target.search;
  };
}

/** `[1, null, 4, 5, 6, 7, 8, null, 20]` — first, last, a window around the current page, gaps as null. */
export function pagesAround(current: number, last: number, window: number): (number | null)[] {
  const pages: (number | null)[] = [];
  for (let page = 1; page <= last; page++) {
    if (page === 1 || page === last || Math.abs(page - current) <= window) pages.push(page);
    else if (pages.at(-1) !== null) pages.push(null);
  }
  return pages;
}
