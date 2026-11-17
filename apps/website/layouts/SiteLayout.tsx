import { Link, usePage, type LayoutProps } from '@marmeon/react';
import { useRef } from 'react';
import { SEARCH_KEYSHORTCUTS, useSearchShortcut, useShortcutHint } from '../modules/docs/components/search-shortcut.ts';
import { SiteFooter } from '../modules/site/components/SiteFooter.tsx';
import { SiteMenuGroups, SiteMenuPanels } from '../modules/site/components/SiteMenu.tsx';
import { useDismissMenus } from '../modules/site/components/useDismissMenus.ts';
import { Wordmark } from '../modules/site/components/Wordmark.tsx';
import { DOCS_URL, GET_STARTED_SLUG, GITHUB_URL, PACKAGES_URL } from '../modules/site/links.ts';

/**
 * Around the landing page and the error pages: skip link, stage header, footer. The mega menu's panels, the menu on a narrow
 * screen (a sheet) and the groups inside that sheet are `<details>` — they open without JavaScript; with it, a visit, Escape or a
 * press outside closes them again, Escape one level at a time.
 */
export function SiteLayout({ children }: LayoutProps) {
  const { url, props } = usePage();
  const panels = props.site?.menu ?? [];
  const header = useRef<HTMLElement>(null);
  const hint = useShortcutHint();
  useSearchShortcut();

  useDismissMenus(header, url);

  return (
    <div className="site">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="site-header stage" ref={header}>
        <div className="site-header-inner">
          <Link route="site.home" className="site-brand" aria-label="Marmeon, home">
            <Wordmark />
          </Link>
          <nav aria-label="Main" className="site-nav">
            {panels.length > 0 ? (
              <SiteMenuPanels panels={panels} />
            ) : (
              <Link href={PACKAGES_URL} className="site-nav-link">
                Packages
              </Link>
            )}
            <Link href={DOCS_URL} className="site-nav-link">
              Docs
            </Link>
          </nav>
          <div className="site-header-end">
            <SearchTrigger hint={hint} className="site-search" />
            {/* Below 900 px the labelled link is hidden and the menu is closed: the magnifier keeps a visible trigger for the shortcut. */}
            <Link route="docs.search" layer className="site-search-icon" data-search-trigger aria-keyshortcuts={SEARCH_KEYSHORTCUTS} aria-label="Search the docs">
              <SearchGlyph />
            </Link>
            <a href={GITHUB_URL} rel="noopener" className="button button--ghost site-github">
              GitHub
            </a>
            <Link href={`${DOCS_URL}/${GET_STARTED_SLUG}`} className="button button--sand site-start" prefetch>
              Get started
            </Link>
            <details className="site-menu">
              <summary>
                <svg className="site-menu-open" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
                <svg className="site-menu-close" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
                <span className="visually-hidden">Menu</span>
              </summary>
              <nav aria-label="Menu" className="site-menu-panel">
                {panels.length > 0 ? (
                  <SiteMenuGroups panels={panels} />
                ) : (
                  <Link href={PACKAGES_URL} className="site-menu-link site-menu-row">
                    Packages
                  </Link>
                )}
                <Link href={DOCS_URL} className="site-menu-link site-menu-row">
                  Docs
                </Link>
                <a href={GITHUB_URL} rel="noopener" className="site-menu-link site-menu-row">
                  GitHub
                </a>
                <Link href={`${DOCS_URL}/${GET_STARTED_SLUG}`} className="button button--sand site-menu-start" prefetch>
                  Get started
                </Link>
              </nav>
            </details>
          </div>
        </div>
      </header>
      <main id="content">{children}</main>
      <SiteFooter />
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

/** "Search docs": the link that opens the search layer, and without JavaScript the search page. */
function SearchTrigger({ hint, className }: { hint: string | null; className: string }) {
  return (
    <Link route="docs.search" layer className={className} data-search-trigger aria-keyshortcuts={SEARCH_KEYSHORTCUTS}>
      <SearchGlyph />
      <span className="site-search-label">Search docs</span>
      {hint && <kbd aria-hidden="true">{hint}</kbd>}
    </Link>
  );
}
