import { Link, usePage, useRouter, type LayoutProps } from '@bespokecore/react';
import { useEffect, useState, type FormEvent } from 'react';

/**
 * Around every page: the header with the search, the side navigation (a shared once-prop), the page. It needs nothing but
 * the navigation — and copes without it: an error page for a path without a route (a 404) gets no shared props.
 */
export function DocsLayout({ children }: LayoutProps) {
  const { props, url } = usePage();
  const nav = props.nav;
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [url]);

  // With JavaScript a visit (the search page's own field takes over); without, the form is an ordinary GET.
  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q');
    void router.visit(`/search?q=${encodeURIComponent(typeof q === 'string' ? q : '')}`);
  };

  return (
    <div className="shell">
      <header className="top">
        {nav && (
          <button type="button" className="menu-button" aria-expanded={menu} aria-controls="sidebar" onClick={() => setMenu(!menu)}>
            Menu
          </button>
        )}
        <Link route="docs.home" className="brand">
          BespokeCore <span>docs</span>
        </Link>
        {!url.startsWith('/search') && (
          <form method="get" action="/search" role="search" className="top-search" onSubmit={search}>
            <input type="search" name="q" placeholder="Search" aria-label="Search the docs" maxLength={100} />
          </form>
        )}
      </header>
      <div className={nav ? 'frame' : 'frame bare'}>
        {nav && (
          <nav id="sidebar" className="sidebar" aria-label="Packages" data-open={menu ? '' : undefined}>
            <Link route="docs.home" className="sidebar-home" prefetch>
              Overview
            </Link>
            {nav.groups.map((group) => (
              <section key={group.title}>
                <h2>{group.title}</h2>
                <ul>
                  {group.packages.map((pkg) => (
                    <li key={pkg.name}>
                      <Link route="docs.package" params={{ name: pkg.name }} prefetch>
                        {pkg.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
        )}
        <main id="content">{children}</main>
      </div>
    </div>
  );
}
