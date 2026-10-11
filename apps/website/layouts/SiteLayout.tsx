import { Link, usePage, type LayoutProps } from '@marmeon/react';
import { useEffect, useRef } from 'react';
import { SiteFooter } from '../modules/site/components/SiteFooter.tsx';
import { VersionBadge } from '../modules/site/components/VersionBadge.tsx';
import { Wordmark } from '../modules/site/components/Wordmark.tsx';
import { DOCS_URL, GITHUB_URL, PACKAGES_URL } from '../modules/site/links.ts';

/**
 * Around the landing page and the error pages: skip link, header, footer. The menu on a narrow screen is a `<details>` — it opens
 * without JavaScript; with it, a visit closes it again.
 */
export function SiteLayout({ children }: LayoutProps) {
  const { url } = usePage();
  const menu = useRef<HTMLDetailsElement>(null);
  // Closes on a visit, not on mount: a menu opened before hydration stays open.
  const shown = useRef(url);
  useEffect(() => {
    if (shown.current === url) return;
    shown.current = url;
    if (menu.current) menu.current.open = false;
  }, [url]);

  return (
    <div className="site">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="site-header">
        <div className="site-header-inner">
          <Link route="site.home" className="site-brand" aria-label="Marmeon, home">
            <Wordmark />
          </Link>
          <div className="site-header-end">
            <nav aria-label="Main" className="site-nav">
              <Link href={DOCS_URL}>Docs</Link>
              <Link href={PACKAGES_URL}>Packages</Link>
              <a href={GITHUB_URL} rel="noopener">
                GitHub
              </a>
            </nav>
            <VersionBadge />
            <details className="site-menu" ref={menu}>
              <summary>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 4.5h12M2 8h12M2 11.5h12" />
                </svg>
                MENU
              </summary>
              <nav aria-label="Menu" className="site-menu-panel">
                <Link href={DOCS_URL}>Docs</Link>
                <Link href={PACKAGES_URL}>Packages</Link>
                <a href={GITHUB_URL} rel="noopener">
                  GitHub
                </a>
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
