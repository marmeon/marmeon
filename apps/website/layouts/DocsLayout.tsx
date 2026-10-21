import { Link, usePage, useRoute, type LayoutProps } from '@marmeon/react';
import { useEffect } from 'react';
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
  const { props, url, component } = usePage();
  // The start page and the search are wide and centred, without the section navigation.
  const onLine = component === 'docs/LinePage' || component === 'docs/LineHome';
  const nav = component === 'docs/Home' || component === 'docs/Search' || component === 'docs/LineHome' ? undefined : onLine ? props.lineNav : props.nav;
  const route = useRoute();
  const searchUrl = route('docs.search');
  const onSearchPage = url.split(/[?#]/)[0] === searchUrl;

  // `/` opens the search through the trigger that is showing, unless the key is meant for a field already, carries a modifier or
  // a dialog is open (no second layer behind an open one).
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return; // no Shift check: `/` needs it on some layouts
      if (event.target instanceof Element && event.target.closest(TYPING)) return;
      if (document.querySelector('dialog[open]')) return;
      // The box is hidden on a phone (the magnifier takes its place): the visible trigger is the one to use. Clicking it opens the
      // layer and lets the layer hand the focus back to the link.
      const trigger = Array.from(document.querySelectorAll<HTMLElement>('[data-search-trigger]')).find((element) => element.offsetParent !== null);
      if (!trigger) return;
      event.preventDefault();
      trigger.focus();
      trigger.click();
    };
    document.addEventListener('keydown', listen);
    return () => document.removeEventListener('keydown', listen);
  }, []);

  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="docs-top">
        <div className="docs-brand">
          <Link route="site.home" className="docs-brand-link" aria-label="Marmeon, home">
            <Wordmark />
          </Link>
          <Link route="docs.home" className="docs-brand-link docs-brand-docs">
            <span className="wordmark-suffix">docs</span>
          </Link>
        </div>
        {!onSearchPage && !onLine && (
          <Link route="docs.search" layer className="docs-search-box" data-search-trigger aria-keyshortcuts="/">
            <SearchIcon size={16} />
            <span className="docs-search-placeholder">Search the docs</span>
            <kbd aria-hidden="true">/</kbd>
          </Link>
        )}
        <div className="docs-top-end">
          {onLine && props.line ? <span className="badge">{props.line.version}</span> : <VersionBadge />}
          <a href={GITHUB_URL} rel="noopener" className="docs-github">
            GitHub
          </a>
          {!onSearchPage && !onLine && (
            <Link route="docs.search" layer className="docs-search-link" data-search-trigger aria-keyshortcuts="/" aria-label="Search the docs">
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
