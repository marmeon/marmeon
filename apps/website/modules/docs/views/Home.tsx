import type { PageProps } from '@marmeon/http';
import { Link, usePage } from '@marmeon/react';
import type { ReactNode } from 'react';
import { SiteHead } from '../../site/components/SiteHead.tsx';
import { DESCRIPTIONS } from '../../site/descriptions.ts';
import { Terminal } from '../../site/components/Terminal.tsx';
import type { ShowHomeController } from '../controllers/ShowHomeController.ts';

/** Where a newcomer begins: install, find the way around an app, answer a first request. */
const START: { path: string; section: string; label: string; description: ReactNode }[] = [
  {
    path: '/docs/installation',
    section: 'Getting Started',
    label: 'Installation',
    description: 'Node 26.10+, pnpm 12 and the starter kit. SQLite in a file, so no database server to set up.',
  },
  {
    path: '/docs/structure',
    section: 'Getting Started',
    label: 'Directory Structure',
    description: (
      <>
        A feature lives in <code>modules/&lt;name&gt;/</code> with its routes, controllers, views and tests.
      </>
    ),
  },
  {
    path: '/docs/routing',
    section: 'The Basics',
    label: 'Routing',
    description: 'Routes, their names, and how one type reaches the page.',
  },
];

const COMMANDS = ['pnpm create marmeon my-app', 'cd my-app', 'pnpm dev'];

const NUMERALS = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
] as const;

/** `4` → `IV`: the number of a section. */
function roman(value: number): string {
  let rest = value;
  let out = '';
  for (const [size, glyph] of NUMERALS) {
    while (rest >= size) {
      out += glyph;
      rest -= size;
    }
  }
  return out;
}

/** `/docs`: what Marmeon is, where to start, then every section of the docs with its pages. */
export default function Home({ sections, lines }: PageProps<ShowHomeController>) {
  const version = usePage().props.site?.version;
  return (
    <div className="docs-home">
      <SiteHead title="Documentation" description={DESCRIPTIONS.docs} path="/docs">
        <link rel="alternate" type="text/markdown" href="/llms.txt" />
      </SiteHead>
      <div className="docs-home-inner">
        <section className="docs-home-intro" aria-labelledby="home-title">
          <div className="docs-home-lead">
            <p className="docs-home-eyebrow">{version ? `Documentation · ${version}` : 'Documentation'}</p>
            <h1 id="home-title">Marmeon</h1>
            <p className="docs-home-summary">
              A full-stack framework for TypeScript on Node.js. An app is a set of modules whose routes, controllers and React pages are typed from
              end to end, and the server renders each page before the browser takes over.
            </p>
            <p className="docs-home-batteries">
              A new app comes with a database, sessions, validation, mail, queues and a scheduler already wired together. Further packages add file
              storage, Redis, live updates and more.
            </p>
          </div>
          <Terminal commands={COMMANDS} />
        </section>
        <section className="docs-home-block docs-home-block-start" aria-labelledby="where-to-start">
          <h2 id="where-to-start" className="docs-home-heading">
            Where to start
          </h2>
          <ol className="docs-home-start">
            {START.map((page, index) => (
              <li key={page.path}>
                <Link href={page.path} prefetch>
                  <span className="docs-home-start-kicker">
                    {index + 1} · {page.section}
                  </span>
                  <span className="docs-home-start-title">{page.label}</span>
                  <span className="docs-home-start-text">{page.description}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
        <section className="docs-home-block" aria-labelledby="every-section">
          <h2 id="every-section" className="docs-home-heading">
            Every section
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
        </section>
        {lines.length > 0 && (
          <section className="docs-home-block" aria-labelledby="release-lines">
            <h2 id="release-lines" className="docs-home-heading">
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
          </section>
        )}
      </div>
    </div>
  );
}
