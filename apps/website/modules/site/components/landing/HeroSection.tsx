import type { PageProps } from '@marmeon/http';
import { Link, usePage } from '@marmeon/react';
import { AGENT_TOOLS } from '../../agents.ts';
import type { ChainStepId } from '../../chain.ts';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { FAKES } from '../../fakes.ts';
import { releaseNotesUrl } from '../../links.ts';
import type { HighlightedSnippet } from '../../SiteSnippets.ts';
import { CopyButton } from '../CopyButton.tsx';
import { StatsStrip } from './StatsStrip.tsx';

const INSTALL_COMMAND = 'pnpm create marmeon my-app';

/** The steps of the chain the rail lights, and the one that ends in the compiler's error. */
const LIT: readonly ChainStepId[] = ['migration', 'controller', 'props'];
const FAILING: ChainStepId = 'props';

type HeroProps = Pick<PageProps<ShowLandingController>, 'snippets' | 'chain' | 'packages'>;

function Arrow() {
  return (
    <svg className="button-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** One window of the hero's composition: a piece of the app, with the step of the chain it stands for. */
function HeroCard({ snippet, step, chain }: { snippet: HighlightedSnippet; step: ChainStepId; chain: HeroProps['chain'] }) {
  return (
    <figure className={`hero-card hero-card--${step}`}>
      <figcaption>
        <span className="hero-card-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="hero-card-file">{snippet.file}</span>
        <span className="hero-card-tag">{chain.find((candidate) => candidate.id === step)?.title}</span>
      </figcaption>
      {/* marmeon-check-ignore inner-html: `html` is the Shiki output of the server (modules/docs/highlight.ts), which escapes the code it highlights */}
      <div className="hero-card-code" dangerouslySetInnerHTML={{ __html: snippet.html }} />
    </figure>
  );
}

/** The first screen: what Marmeon is, the way in, a thread of one type through three files, and the numbers the rest of the page backs. */
export function HeroSection({ snippets, chain, packages }: HeroProps) {
  const version = usePage().props.site?.version;
  const failing = chain.find((step) => step.id === FAILING);
  return (
    <section className="hero stage stage--veins-hero" aria-labelledby="hero-title">
      <div className="landing-inner hero-inner">
        <div className="hero-copy">
          {version && (
            <a className="hero-release" href={releaseNotesUrl(version)} rel="noopener">
              <span className="hero-release-version">{version}</span>
              Release notes
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </a>
          )}
          <h1 id="hero-title">
            <span className="hero-line">Typed end to end.</span> <span className="hero-line serif-accent">Batteries included.</span>
          </h1>
          <p className="lead">
            A TypeScript framework for the whole app, server first. Routes, controllers, pages and forms share one type, from the database column to the form error. Authorization, migrations, validation, a
            queue, mail, a scheduler and storage are part of the framework and work together. Every page renders on the server first.
          </p>
          <div className="hero-actions">
            <Link href="/docs/installation" className="button button--sand" prefetch>
              Get started
              <Arrow />
            </Link>
            <Link href="/docs" className="button button--ghost" prefetch>
              Read the docs
            </Link>
          </div>
          <div className="hero-install">
            <span className="hero-install-prompt" aria-hidden="true">
              $
            </span>
            <code>{INSTALL_COMMAND}</code>
            <CopyButton text={INSTALL_COMMAND} label="Copy the install command" />
          </div>
          <p className="hero-facts">MIT licence · Node 26.10+ · No transpile step</p>
        </div>
        <div className="hero-composition">
          <ol className="hero-rail" aria-hidden="true">
            {chain.map((step) => (
              <li key={step.id} className={`hero-rail-step${LIT.includes(step.id) ? ' is-lit' : ''}${step.id === FAILING ? ' is-error' : ''}`}>
                <span className="hero-rail-dot" />
                {step.title}
              </li>
            ))}
          </ol>
          <div className="hero-cards">
            <HeroCard snippet={snippets.migrationColumns} step="migration" chain={chain} />
            <HeroCard snippet={snippets.controller} step="controller" chain={chain} />
            <HeroCard snippet={snippets.page} step="props" chain={chain} />
            {failing && (
              <div className="hero-error" role="note">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v6M12 16.5v.5" />
                </svg>
                <div>
                  {/* marmeon-check-ignore inner-html: `mistake` is the Shiki output of the server (SiteSnippets), which escapes the code it highlights */}
                  <div className="hero-error-line" dangerouslySetInnerHTML={{ __html: failing.mistake }} />
                  <p>{`error ${failing.error.code}: ${failing.error.message}`}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="landing-inner">
        <StatsStrip packages={packages.length} typos={chain.length} fakes={FAKES.length} tools={AGENT_TOOLS.length} />
      </div>
    </section>
  );
}
