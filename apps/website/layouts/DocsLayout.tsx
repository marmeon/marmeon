import { Link, usePage, useRoute, useRouter, type LayoutProps } from '@marmeon/react';
import { useEffect, useRef, type FormEvent } from 'react';
import { DocsMenu, DocsSidebar } from '../modules/docs/components/DocsNav.tsx';
import { SiteFooter } from '../modules/site/components/SiteFooter.tsx';
import { VersionBadge } from '../modules/site/components/VersionBadge.tsx';
import { Wordmark } from '../modules/site/components/Wordmark.tsx';
import { GITHUB_URL } from '../modules/site/links.ts';

/** A key press that belongs to a field or an editor: the `/` shortcut leaves it alone. */
const TYPING = 'input, textarea, select, [contenteditable]';

/**
 * Around every page of the docs: the top bar with the search, the side navigation (a shared once-prop), the page. It needs
 * nothing but the navigation — and copes without it: an error page for a path without a route (a 404) gets no shared props.
 */
export function DocsLayout({ children }: LayoutProps) {
  const { props, url } = usePage();
  const nav = props.nav;
  const router = useRouter();
  const route = useRoute();
  const searchUrl = route('docs.search');
  const onSearchPage = url.split(/[?#]/)[0] === searchUrl;
  const field = useRef<HTMLInputElement>(null);

  // `/` jumps to the search field, unless the key is meant for a field already or carries a modifier.
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest(TYPING)) return;
      // Hidden on a phone (the search link takes its place): nothing to focus, so the key stays a key.
      if (!field.current || field.current.offsetParent === null) return;
      event.preventDefault();
      field.current.focus();
    };
    document.addEventListener('keydown', listen);
    return () => document.removeEventListener('keydown', listen);
  }, []);

  // With JavaScript a visit (the search page's own field takes over); without, the form is an ordinary GET.
  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q');
    void router.visit(`${searchUrl}?q=${encodeURIComponent(typeof q === 'string' ? q : '')}`);
  };

  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="docs-top">
        <Link route="docs.home" className="docs-brand" aria-label="Marmeon documentation, start page">
          <Wordmark suffix="docs" />
        </Link>
        {!onSearchPage && (
          <form method="get" action={searchUrl} role="search" className="docs-search" onSubmit={search}>
            <label htmlFor="docs-search-field" className="visually-hidden">
              Search the documentation
            </label>
            <div className="docs-search-box">
              <SearchIcon size={16} />
              <input id="docs-search-field" ref={field} type="search" name="q" placeholder="Search the docs" maxLength={100} />
              <kbd aria-hidden="true">/</kbd>
            </div>
          </form>
        )}
        <div className="docs-top-end">
          <VersionBadge />
          <a href={GITHUB_URL} rel="noopener" className="docs-github">
            GitHub
          </a>
          {!onSearchPage && (
            <Link route="docs.search" className="docs-search-link" aria-label="Search the docs">
              <SearchIcon size={18} />
            </Link>
          )}
        </div>
      </header>
      {nav && <DocsMenu nav={nav} url={url} />}
      <div className={nav ? 'docs-frame' : 'docs-frame docs-frame--bare'}>
        {nav && <DocsSidebar nav={nav} url={url} />}
        <main id="content">{children}</main>
      </div>
      <SiteFooter />
    </div>
  );
}

function SearchIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}
