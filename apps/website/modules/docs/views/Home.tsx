import type { PageProps } from '@marmeon/http';
import { Link, usePage } from '@marmeon/react';
import { SiteHead } from '../../site/components/SiteHead.tsx';
import { DESCRIPTIONS } from '../../site/descriptions.ts';
import { Terminal } from '../../site/components/Terminal.tsx';
import type { ShowHomeController } from '../controllers/ShowHomeController.ts';
import { SEARCH_KEYSHORTCUTS, useShortcutHint } from '../components/search-shortcut.ts';
import { START } from '../components/start-pages.tsx';
import { roman } from '../roman.ts';

const COMMANDS = ['pnpm create marmeon my-app', 'cd my-app', 'pnpm dev'];

const ARROW = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

/** What the page tells a coding agent: only what `docs/mcp.md` and the website's llms.txt routes answer. */
const AGENT_WAYS = [
  { name: '/llms.txt', href: '/llms.txt', text: 'A short index of every page, for language models.' },
  { name: '/llms-full.txt', href: '/llms-full.txt', text: 'All pages in one file.' },
  { name: 'View as Markdown', href: '/docs/installation.md', text: 'Every page as plain Markdown, at its address with .md. This one is Installation.' },
  { name: 'docs_search · docs_read', href: '/docs/mcp', text: 'MCP tools that look up the docs of the installed version.' },
] as const;

/**
 * `/docs`: the hero (what Marmeon is, the search trigger, the first commands), the three pages to start with, the recipes, every section of
 * the docs with its pages, the ways a coding agent reads the docs, and the release lines.
 */
export default function Home({ sections, lines }: PageProps<ShowHomeController>) {
  const version = usePage().props.site?.version;
  const hint = useShortcutHint();
  const recipes = sections.find((section) => section.title === 'Recipes');
  return (
    <div className="docs-home">
      <SiteHead title="Documentation" description={DESCRIPTIONS.docs} path="/docs">
        <link rel="alternate" type="text/markdown" href="/llms.txt" />
      </SiteHead>
      <section className="stage stage--veins-band docs-home-hero" aria-labelledby="home-title">
        <div className="docs-home-hero-inner">
          <div className="docs-home-lead">
            <p className="docs-home-eyebrow">{version ? `Documentation · ${version}` : 'Documentation'}</p>
            <h1 id="home-title">
              Marmeon <span className="serif-accent">documentation</span>
            </h1>
            <p className="docs-home-summary">
              A full-stack framework for TypeScript on Node.js. An app is a set of modules whose routes, controllers and React pages are typed from
              end to end, and the server renders each page before the browser takes over.
            </p>
            <Link route="docs.search" layer className="docs-home-search" data-search-trigger aria-keyshortcuts={SEARCH_KEYSHORTCUTS}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <span className="docs-home-search-text">Search routes, policies, queues…</span>
              {hint && <kbd aria-hidden="true">{hint}</kbd>}
            </Link>
          </div>
          <div className="docs-home-terminal">
            <Terminal commands={COMMANDS} />
            <p className="docs-home-batteries">
              A new app comes with a database, sessions, validation, mail, queues and a scheduler already wired together. Further packages add file
              storage, Redis, live updates and more.
            </p>
          </div>
        </div>
      </section>
      <section className="docs-home-block docs-home-block-start" aria-labelledby="where-to-start">
        <div className="docs-home-frame">
          <p className="docs-home-label">Where to start</p>
          <h2 id="where-to-start" className="docs-home-heading">
            Three pages, <span className="serif-accent">then your first module.</span>
          </h2>
          <ol className="docs-home-start">
            {START.map((page, index) => (
              <li key={page.path}>
                <Link href={page.path} prefetch>
                  <span className="docs-home-start-head">
                    <span className="docs-home-start-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="docs-home-start-kicker">{page.section}</span>
                  </span>
                  <span className="docs-home-start-title">{page.label}</span>
                  <span className="docs-home-start-text">{page.description}</span>
                  <span className="docs-home-start-read">Read {ARROW}</span>
                </Link>
              </li>
            ))}
          </ol>
          {recipes && recipes.pages.length > 0 && (
            <div className="docs-home-recipes">
              <div className="docs-home-recipes-head">
                <h3>
                  Recipes <span className="serif-accent">a feature, start to finish</span>
                </h3>
              </div>
              <ul>
                {recipes.pages.map((page) => (
                  <li key={page.path}>
                    <Link href={page.path} prefetch>
                      <span>{page.label}</span>
                      {ARROW}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
      <section className="docs-home-block docs-home-block-all" aria-labelledby="every-section">
        <div className="docs-home-frame">
          <p className="docs-home-label">Every section</p>
          <h2 id="every-section" className="docs-home-heading">
            One topic per page.
          </h2>
          <div className="docs-home-sections">
            {sections.map((section, index) => (
              <section key={section.title} aria-labelledby={`section-${index + 1}`}>
                <h3 id={`section-${index + 1}`}>
                  <span className="docs-home-number" aria-hidden="true">
                    {roman(index + 1)}
                  </span>
                  {section.title}
                </h3>
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
        </div>
      </section>
      <section className="stage docs-home-agents" aria-labelledby="for-agents">
        <div className="docs-home-agents-inner">
          <div className="docs-home-agents-intro">
            <p className="docs-home-label">For your coding agent</p>
            <h2 id="for-agents" className="docs-home-heading">
              The same docs, <span className="serif-accent">in a form it reads.</span>
            </h2>
            <p>
              Every page is also served as Markdown, and <code>/llms.txt</code> indexes them. In development, the MCP server answers from the docs of
              exactly the installed version.
            </p>
          </div>
          <ul className="docs-home-agent-list">
            {AGENT_WAYS.map((way) => (
              <li key={way.name}>
                {way.href === '/docs/mcp' ? (
                  <Link href={way.href} prefetch className="docs-home-agent-name">
                    {way.name}
                  </Link>
                ) : (
                  <a href={way.href} className="docs-home-agent-name">
                    {way.name}
                  </a>
                )}
                <span className="docs-home-agent-text">{way.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      {lines.length > 0 && (
        <section className="docs-home-block docs-home-block-lines" aria-labelledby="release-lines">
          <div className="docs-home-frame">
            <h2 id="release-lines" className="docs-home-label">
              Release lines
            </h2>
            <p>The documentation of older versions, for an app that has not upgraded yet.</p>
            <ul>
              {lines.map((line) => (
                <li key={line.name}>
                  <Link href={line.path}>
                    Marmeon {line.version} ({line.name})
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
