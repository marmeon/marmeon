import type { PageProps } from '@marmeon/http';
import { Link, usePage } from '@marmeon/react';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { GITHUB_URL } from '../../links.ts';
import { Editor } from '../Editor.tsx';
import { Terminal } from '../Terminal.tsx';

/** The first screen: what Marmeon is, the commands that start an app, and the controller and page that share their prop types. */
export function HeroSection({ snippets }: Pick<PageProps<ShowLandingController>, 'snippets'>) {
  const version = usePage().props.site?.version;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="landing-inner hero-inner">
        <div className="hero-copy">
          <p className="eyebrow">A TypeScript framework for the whole app, server first</p>
          <h1 id="hero-title">The whole app, typed and included.</h1>
          <p className="lead">
            Routes, controllers, pages and forms share one type, from the database column to the form error. Authorization, migrations, validation, a queue, mail, a
            scheduler and storage are part of the framework and work together. Every page renders on the server first.
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
          <p className="hero-facts">{[version, 'MIT licence', 'Node 26.10+'].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <div className="landing-inner">
        <div className="hero-code">
          <Editor
            label="The controller and the page that takes its props from it"
            layout="split"
            headingLevel={null}
            files={[
              { name: snippets.controller.file!, html: snippets.controller.html },
              { name: snippets.page.file!, html: snippets.page.html },
            ]}
          />
        </div>
        <p className="hero-note">The page takes its prop types from the controller. Change one, and the other no longer compiles.</p>
      </div>
    </section>
  );
}
