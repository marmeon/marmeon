import { Link } from '@marmeon/react';
import type { ReactNode } from 'react';

const SITUATIONS: { title: string; before: ReactNode; after: ReactNode; href: string; page: string }[] = [
  {
    title: 'Your app grew past its pages.',
    before: 'It started with pages. Then came background jobs, mail, a nightly task and permissions, each with its own tool and its own setup, and the logic spread across request handlers.',
    after: (
      <>
        Jobs, mail, scheduled tasks, policies and migrations are part of the framework and work together. <code>pnpm dev</code> starts the server, a queue worker and the scheduler together, and every React page
        still renders on the server first.
      </>
    ),
    href: '/docs/installation#running-the-app',
    page: 'Running the app',
  },
  {
    title: 'You know structure. Now you write TypeScript.',
    before: 'You come from a language where every task has its place and a command that writes the first file. In TypeScript, each project assembles its own stack, and no two are laid out alike.',
    after: (
      <>
        Every app has the same layout: modules, one class per endpoint, <code>make:*</code> generators and a starter kit with sign-in built in. One type runs from the migration to the form error.
      </>
    ),
    href: '/docs/structure',
    page: 'Directory Structure',
  },
  {
    title: 'Your backend lives in the database.',
    before: 'Sign-in, tables and file storage were running in an afternoon. Now the product is real, and its rules are spread over access policies in the database, its functions and the client.',
    after: (
      <>
        The rules live in TypeScript on the server, one module per feature. Policies stand next to the route, a misspelt ability does not compile, and a transaction that returns an <code>err</code> rolls back.
      </>
    ),
    href: '/docs/authorization',
    page: 'Authorization',
  },
  {
    title: 'Many projects, and agents writing along.',
    before: 'You look after many apps for years. People come and go, part of the code is written by an agent, and each project has to be learnt again before anyone trusts a change.',
    after: 'Know one app and you know them all: the same structure everywhere, tests through the whole kernel. A route that does not say who may call it does not start, and neither does an open route that loads records by id.',
    href: '/docs/authorization#every-route-decides',
    page: 'Every route decides',
  },
];

/** "Your business logic gets a home": four situations a reader knows, what Marmeon does there, and who it does not fit. */
export function AudienceSection() {
  return (
    <section className="audience" aria-labelledby="audience-title">
      <div className="landing-inner">
        <div className="section-intro section-intro--wide">
          <p className="section-label">Who it is for</p>
          <h2 id="audience-title">Your business logic gets a home.</h2>
          <p>
            Marmeon is a backend framework for TypeScript that brings the frontend with it. Who may open a record, what happens after a sign-up, which failure a caller must handle: each has its place in a module on
            the server, as code you can read, test and review.
          </p>
        </div>
        <ul className="audience-list">
          {SITUATIONS.map(({ title, before, after, href, page }) => (
            <li key={title} className="audience-card">
              <h3>{title}</h3>
              <dl>
                <dt>You know this</dt>
                <dd>{before}</dd>
                <dt className="audience-with">With Marmeon</dt>
                <dd>{after}</dd>
              </dl>
              <Link href={href}>{page}</Link>
            </li>
          ))}
        </ul>
        <p className="audience-fit">
          <strong>Not the right fit</strong> for a static site: pages built once and served as files, with nothing to run on a server.
        </p>
      </div>
    </section>
  );
}
