import type { PaginationMeta } from '@bespokecore/http/page';
import type { ReactNode } from 'react';
import { usePage } from './app.tsx';
import { Link } from './link.tsx';

export interface PaginationProps {
  meta: PaginationMeta;
  /** Pages shown on each side of the current one (default 2): `1 … 4 5 [6] 7 8 … 20`. */
  window?: number;
  /** The query parameter that carries the page (default `page`). */
  param?: string;
}

/**
 * Links to the pages of a list (`paginate()`'s `meta`). Keeps the rest of the query string — a filter
 * like `?q=ada` stays when the page changes. Renders nothing for a single page.
 */
export function Pagination({ meta, window = 2, param = 'page' }: PaginationProps): ReactNode {
  const { url } = usePage();
  if (meta.lastPage <= 1) return null;

  const href = (page: number) => {
    const target = new URL(url, 'http://localhost');
    if (page === 1) target.searchParams.delete(param);
    else target.searchParams.set(param, String(page));
    return target.pathname + target.search;
  };
  const pages = pagesAround(meta.page, meta.lastPage, window);

  return (
    <nav aria-label="Pagination">
      {meta.page > 1 && (
        <Link href={href(meta.page - 1)} rel="prev">
          ‹ Previous
        </Link>
      )}{' '}
      {pages.map((page, index) =>
        page === null ? (
          <span key={`gap-${index}`}> … </span>
        ) : page === meta.page ? (
          <strong key={page} aria-current="page">
            {' '}
            {page}{' '}
          </strong>
        ) : (
          <Link key={page} href={href(page)} aria-label={`Page ${page}`}>
            {' '}
            {page}{' '}
          </Link>
        ),
      )}{' '}
      {meta.page < meta.lastPage && (
        <Link href={href(meta.page + 1)} rel="next">
          Next ›
        </Link>
      )}
    </nav>
  );
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
