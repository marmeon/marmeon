import type { PageProps } from '@marmeon/http';
import { Link, usePage } from '@marmeon/react';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { GITHUB_URL } from '../../links.ts';
import { CodeBlock } from '../CodeBlock.tsx';
import { Terminal } from '../Terminal.tsx';

/** The first screen: what Marmeon is, the commands that start an app, and the controller and page that share their prop types. */
export function HeroSection({ snippets }: Pick<PageProps<ShowLandingController>, 'snippets'>) {
  const version = usePage().props.site?.version;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="landing-inner hero-inner">
        <div className="hero-copy">
          <p className="eyebrow">A full-stack framework for TypeScript on Node.js</p>
          <h1 id="hero-title">One type, from the database column to the form error.</h1>
          <p className="lead">
            Routes, controllers and views are typed end to end. The server renders each page before the browser takes over, and a new app starts with a
            database, sessions, validation, mail, a queue and a scheduler already wired together.
          </p>
        </div>
        <div className="hero-start">
          <Terminal commands={['pnpm create marmeon my-app', 'cd my-app', 'pnpm dev']} />
          <div className="hero-actions">
            <Link href="/docs/installation" className="button" prefetch>
              Get started
            </Link>
            <Link href="/docs" className="button button--secondary" prefetch>
              Read the docs
            </Link>
            <a className="button button--text" href={GITHUB_URL} rel="noopener">
              GitHub repository
            </a>
          </div>
          <p className="hero-facts">{[version, 'release in preparation', 'MIT licence', 'Node 26.10+'].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <div className="landing-inner">
        <div className="hero-code">
          <CodeBlock copy={false} html={snippets.controller.html} caption={snippets.controller.file} />
          <CodeBlock copy={false} html={snippets.page.html} caption={snippets.page.file} />
        </div>
        <p className="hero-note">The page takes its prop types from the controller. Change one, and the other no longer compiles.</p>
      </div>
    </section>
  );
}
