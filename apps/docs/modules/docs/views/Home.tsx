import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowHomeController } from '../controllers/ShowHomeController.ts';

/** Where a newcomer begins: install, find the way around an app, answer a first request. */
const START = [
  { label: 'Installation', path: '/docs/installation' },
  { label: 'Directory Structure', path: '/docs/structure' },
  { label: 'Routing', path: '/docs/routing' },
];

/** `/`: what Marmeon is, where to start, then every section of the docs with its pages. */
export default function Home({ sections }: PageProps<ShowHomeController>) {
  return (
    <div className="page home">
      <Head title="" />
      <article className="doc">
        <h1>Marmeon</h1>
        <p className="lead">
          Marmeon is a full-stack framework for TypeScript: a modular monolith on Node.js that runs your TypeScript as it is, renders React pages on the
          server and brings what a web app needs — sessions, authentication, mail, queues, a scheduler, file storage and live updates, each with a
          contract, drivers to choose from and a fake for your tests.
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
