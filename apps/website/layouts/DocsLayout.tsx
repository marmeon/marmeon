import { Link, usePage, useRoute, type LayoutProps } from '@marmeon/react';
import { DocsMenu, DocsSidebar } from '../modules/docs/components/DocsNav.tsx';
import { SEARCH_KEYSHORTCUTS, useSearchShortcut } from '../modules/docs/components/search-shortcut.ts';
import { SiteFooter } from '../modules/site/components/SiteFooter.tsx';
import { VersionBadge } from '../modules/site/components/VersionBadge.tsx';
import { Wordmark } from '../modules/site/components/Wordmark.tsx';
import { GITHUB_URL } from '../modules/site/links.ts';

/**
 * Around every page of the docs: the top bar with the search, the side navigation (a shared once-prop), the page. It needs
 * nothing but the navigation — and copes without it: an error page for a path without a route (a 404) gets no shared props.
 */
export function DocsLayout({ children }: LayoutProps) {
  const { props, url, component } = usePage();
  // The start page and the search are wide and centred, without the section navigation.
  const onLine = component === 'docs/LinePage' || component === 'docs/LineHome';
  const nav = component === 'docs/Home' || component === 'docs/Search' || component === 'docs/LineHome' ? undefined : onLine ? props.lineNav : props.nav;
  const route = useRoute();
  const searchUrl = route('docs.search');
  const onSearchPage = url.split(/[?#]/)[0] === searchUrl;

  useSearchShortcut();

  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="docs-top stage">
        <div className="docs-top-inner">
          <Link route="docs.home" className="docs-brand" aria-label="Marmeon docs home">
            <Wordmark />
            <span className="wordmark-suffix">docs</span>
          </Link>
          {onLine && props.line ? <span className="badge">{props.line.version}</span> : <VersionBadge />}
          {!onSearchPage && !onLine && (
            <Link route="docs.search" layer className="docs-search-box" data-search-trigger aria-keyshortcuts={SEARCH_KEYSHORTCUTS}>
              <SearchIcon size={16} />
              <span className="docs-search-placeholder">Search the docs</span>
              <kbd aria-hidden="true">/</kbd>
            </Link>
          )}
          <nav aria-label="Site" className="docs-top-nav">
            <Link route="site.home" className="docs-framework">
              Framework
            </Link>
            <a href={GITHUB_URL} rel="noopener" className="button button--ghost docs-github">
              GitHub
            </a>
          </nav>
          {!onSearchPage && !onLine && (
            <Link route="docs.search" layer className="docs-search-link" data-search-trigger aria-keyshortcuts={SEARCH_KEYSHORTCUTS} aria-label="Search the docs">
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
      <SiteFooter compact />
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
