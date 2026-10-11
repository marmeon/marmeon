import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowHomeController } from '../controllers/ShowHomeController.ts';

/** Where a newcomer begins: install, find the way around an app, answer a first request. */
const START = [
  { label: 'Installation', path: '/docs/installation' },
  { label: 'Directory Structure', path: '/docs/structure' },
  { label: 'Routing', path: '/docs/routing' },
];

/** `/docs`: what Marmeon is, where to start, then every section of the docs with its pages. */
export default function Home({ sections }: PageProps<ShowHomeController>) {
  return (
    <div className="page home">
      <Head title="Documentation" />
      <article className="doc">
        <h1>Marmeon</h1>
        <p className="lead">
          Marmeon is a full-stack framework for TypeScript on Node.js: an app is a set of modules whose routes, controllers and React pages are typed
          from end to end, and the server renders each page before the browser takes over. A new app comes with a database, sessions, validation,
          mail, queues and a scheduler already wired together, and further packages add file storage, Redis, live updates and more.
        </p>
        <section className="start" aria-labelledby="start-here">
          <h2 id="start-here">Start here</h2>
          <ul>
            {START.map((page) => (
              <li key={page.path}>
                <Link href={page.path} prefetch>
                  {page.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <div className="sections">
          {sections.map((section) => (
            <section key={section.title}>
              <h2>{section.title}</h2>
              <ul>
                {section.pages.map((page) => (
                  <li key={page.path}>
                    <Link href={page.path} prefetch>
                      {page.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </article>
    </div>
  );
}
