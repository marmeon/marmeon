import { Link } from '@marmeon/react';
import { DISCORD_URL, DISCUSSIONS_URL } from '../../links.ts';
import { Terminal } from '../Terminal.tsx';

const READING: { href: string; title: string; text: string }[] = [
  { href: '/docs/installation', title: 'Installation', text: 'Requirements, the starter kit and its flags.' },
  { href: '/docs/structure', title: 'Directory Structure', text: 'Where modules and their files live.' },
  { href: '/docs/routing', title: 'Routing', text: 'Routes, names and route model binding.' },
];

/** "Three commands to a running app": the commands again, and where to read next. */
export function StartSection() {
  return (
    <section className="start" aria-labelledby="start-title">
      <div className="landing-inner landing-columns">
        <div className="section-intro">
          <p className="section-label">Get started</p>
          <h2 id="start-title">Three commands to a running app.</h2>
          <p>
            The starter kit brings sign-in and registration, a home page, devtools, oxlint and Vitest. SQLite runs in a file, so no database server is needed.{' '}
            <code>--minimal</code> creates a blank app; <code>--docker</code> adds container files. The app answers on http://localhost:3000.
          </p>
          <Terminal commands={['pnpm create marmeon my-app', 'cd my-app', 'pnpm dev']} />
        </div>
        <div className="start-reading">
          <nav aria-label="Start reading">
            <ul>
              {READING.map(({ href, title, text }) => (
                <li key={href}>
                  <Link href={href} prefetch>
                    <span className="start-reading-text">
                      <span className="start-reading-title">{title}</span>
                      <span>{text}</span>
                    </span>
                    <span className="start-reading-arrow" aria-hidden="true">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="start-actions">
            <Link href="/docs/installation" className="button" prefetch>
              Get started
            </Link>
            <Link href="/docs" className="button button--secondary" prefetch>
              Read the docs
            </Link>
          </div>
          <p className="start-community">
            Questions, or something to show? Join the{' '}
            <a href={DISCORD_URL} rel="noopener">
              Discord
            </a>{' '}
            or start a{' '}
            <a href={DISCUSSIONS_URL} rel="noopener">
              discussion on GitHub
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  );
}
