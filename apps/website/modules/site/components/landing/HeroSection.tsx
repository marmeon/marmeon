import type { PageProps } from '@marmeon/http';
import { Link, usePage } from '@marmeon/react';
import { AGENT_TOOLS } from '../../agents.ts';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { FAKES } from '../../fakes.ts';
import { releaseNotesUrl } from '../../links.ts';
import { CopyButton } from '../CopyButton.tsx';
import { StatsStrip } from './StatsStrip.tsx';

const INSTALL_COMMAND = 'pnpm create marmeon my-app';

type HeroProps = Pick<PageProps<ShowLandingController>, 'chain' | 'packages' | 'stack'>;

function Arrow() {
  return (
    <svg className="button-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** A row of the battery chips: each a link to the package's docs page. */
function Chips({ chips, label }: { chips: HeroProps['stack']['above']; label: string }) {
  return (
    <ul className="hero-chips" aria-label={label}>
      {chips.map((chip) => (
        <li key={chip.href}>
          <Link href={chip.href} className="hero-chip">
            {chip.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The first screen: what Marmeon is, the way in, the layers of an app with one type through them, and the numbers the rest of the page backs. */
export function HeroSection({ chain, packages, stack }: HeroProps) {
  const version = usePage().props.site?.version;
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
            <span className="hero-line">The modern <span className="nowrap">full-stack</span> framework</span> <span className="hero-line serif-accent">for TypeScript.</span>
          </h1>
          <p className="lead">
            Routes, database, auth, queues, mail and pages in one TypeScript framework. One type runs from the column to the form, and every page renders on the server first.
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
        <div className="hero-composition" role="group" aria-label="The layers of a Marmeon app">
          <Chips chips={stack.above} label="Batteries around the layers" />
          <div className="hero-layers">
            <span className="hero-thread-label">
              one type
            </span>
            <ol className="hero-layer-list">
              {stack.layers.map((layer) => (
                <li key={layer.href}>
                  <Link href={layer.href} className="hero-layer">
                    <span className="hero-layer-title">{layer.title}</span>
                    <span className="hero-layer-note">{layer.note}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
          <Chips chips={stack.below} label="More batteries" />
        </div>
      </div>
      <div className="landing-inner">
        <StatsStrip packages={packages.length} layers={chain.length} fakes={FAKES.length} tools={AGENT_TOOLS.length} />
      </div>
    </section>
  );
}
