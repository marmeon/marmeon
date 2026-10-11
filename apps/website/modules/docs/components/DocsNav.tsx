import { Link } from '@marmeon/react';
import { useEffect, useRef } from 'react';
import type { Navigation } from '../DocsRepository.ts';

const pathOf = (url: string) => url.split(/[?#]/)[0];

/** The sections as `<details>`, the one holding the current page open — decided from the URL, so the server renders it open. */
function Sections({ nav, url }: { nav: Navigation; url: string }) {
  const path = pathOf(url);
  return (
    <>
      {nav.groups.map((group) => (
        <details key={group.title} className="nav-section" open={group.pages.some((page) => page.path === path)}>
          <summary>
            {group.title}
            <span className="nav-sign" aria-hidden="true" />
          </summary>
          <ul>
            {group.pages.map((page) => (
              <li key={page.path}>
                <Link href={page.path} prefetch className="nav-item">
                  {page.label}
                  {page.pending && <span className="draft">draft</span>}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}

/** The side navigation beside the page; hidden on a phone, where `DocsMenu` takes over. */
export function DocsSidebar({ nav, url }: { nav: Navigation; url: string }) {
  return (
    <aside className="sidebar">
      <nav aria-label="Documentation">
        <Sections nav={nav} url={url} />
      </nav>
    </aside>
  );
}

/**
 * The same navigation behind a `<details>` above the page, for a phone: it opens without JavaScript; with it, a visit closes it
 * again. Its summary names the section and the page.
 */
export function DocsMenu({ nav, url }: { nav: Navigation; url: string }) {
  const path = pathOf(url);
  const group = nav.groups.find((candidate) => candidate.pages.some((page) => page.path === path));
  const page = group?.pages.find((candidate) => candidate.path === path);
  const menu = useRef<HTMLDetailsElement>(null);
  // Closes on a visit, not on mount: a menu opened before hydration stays open.
  const shown = useRef(url);
  useEffect(() => {
    if (shown.current === url) return;
    shown.current = url;
    if (menu.current) menu.current.open = false;
  }, [url]);

  return (
    <details className="docs-menu" ref={menu}>
      <summary>
        <span className="docs-menu-label">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4.5h12M2 8h12M2 11.5h12" />
          </svg>
          {group && page ? (
            <>
              <span className="docs-menu-section">{group.title}</span>
              <span className="docs-menu-page">{page.label}</span>
            </>
          ) : (
            <span className="docs-menu-page">Documentation</span>
          )}
        </span>
        <span className="nav-sign" aria-hidden="true" />
      </summary>
      <nav aria-label="Documentation menu" className="docs-menu-panel">
        <Sections nav={nav} url={url} />
      </nav>
    </details>
  );
}
