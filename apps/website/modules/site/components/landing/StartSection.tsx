import { Link } from '@marmeon/react';
import { GITHUB_URL } from '../../links.ts';
import { Mark } from '../Mark.tsx';
import { Terminal } from '../Terminal.tsx';

const READING: { href: string; title: string; text: string }[] = [
  { href: '/docs/installation', title: 'Installation', text: 'Requirements, the starter kit and its flags.' },
  { href: '/docs/structure', title: 'Directory Structure', text: 'Where modules and their files live.' },
  { href: '/docs/routing', title: 'Routing', text: 'Routes, names and route model binding.' },
];

/** "Three commands to a running app": the commands again, and where to read next. */
export function StartSection() {
  return (
    <section className="start stage stage--veins-band" aria-labelledby="start-title">
      <div className="landing-inner">
        <div className="start-frame">
          <div className="start-copy">
            <span className="start-mark">
              <Mark size={24} />
            </span>
            <h2 id="start-title">
              Three commands <span className="serif-accent">to a running app.</span>
            </h2>
            <p>
              The starter kit brings sign-in and registration, a home page, devtools, oxlint and Vitest. SQLite runs in a file, so no database server is needed. <code>--minimal</code> creates a blank app;{' '}
              <code>--docker</code> adds container files. The app answers on http://localhost:3000.
            </p>
            <div className="start-actions">
              <Link href="/docs/installation" className="button button--sand" prefetch>
                Read the installation guide
                <svg className="button-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
              <a className="button button--ghost" href={GITHUB_URL} rel="noopener">
                Star on GitHub
              </a>
            </div>
          </div>
          <div className="start-side">
            <Terminal commands={['pnpm create marmeon my-app', 'cd my-app', 'pnpm dev']} />
            <nav aria-label="Start reading">
              <ul>
                {READING.map(({ href, title, text }) => (
                  <li key={href}>
                    <Link href={href} prefetch>
                      <span className="start-reading-title">{title}</span>
                      <span className="start-reading-text">{text}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>
      </div>
    </section>
  );
}
