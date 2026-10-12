import type { PageProps } from '@marmeon/http';
import { Link, usePage } from '@marmeon/react';
import type { ReactNode } from 'react';
import { ChainStep } from '../components/ChainStep.tsx';
import { CodeBlock } from '../components/CodeBlock.tsx';
import { BatteriesSection } from '../components/landing/BatteriesSection.tsx';
import { DevtoolsSection } from '../components/landing/DevtoolsSection.tsx';
import { ModulesSection } from '../components/landing/ModulesSection.tsx';
import { SecureSection } from '../components/landing/SecureSection.tsx';
import { StartSection } from '../components/landing/StartSection.tsx';
import { TestingSection } from '../components/landing/TestingSection.tsx';
import { SiteHead } from '../components/SiteHead.tsx';
import { Terminal } from '../components/Terminal.tsx';
import type { ShowLandingController } from '../controllers/ShowLandingController.ts';
import { DESCRIPTIONS } from '../descriptions.ts';
import { GITHUB_URL } from '../links.ts';

const PRINCIPLES: { name: string; text: ReactNode }[] = [
  { name: 'Typed end to end', text: 'From the database column through the controller, validation and route names to the form error in the React component.' },
  { name: 'No global state', text: 'No facades, no singletons holding request data: one application, a scope per request or job.' },
  { name: 'TypeScript runs natively on Node', text: 'No transpile step, no decorators.' },
  { name: 'Modules first', text: 'A module brings its routes, providers, migrations, views and tests; installed packages register themselves.' },
  {
    name: 'One endpoint, one class',
    text: (
      <>
        Controllers, jobs, listeners, commands, mails and policies are classes with <code>handle()</code>.
      </>
    ),
  },
  { name: 'Batteries included, behind contracts', text: 'Mail, the queue, notifications, storage, events, live updates and the schedule each have a fake for tests.' },
  { name: 'Secure by default', text: 'In production, and wherever nobody set the environment, protections stay on.' },
];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** `/`: what Marmeon is, its principles, one type followed from the database to the form, and the rest of the framework in six sections. */
export default function Landing({ snippets }: PageProps<ShowLandingController>) {
  const version = usePage().props.site?.version;
  return (
    <div className="landing">
      <SiteHead title="" description={DESCRIPTIONS.landing} path="/" />
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
            <CodeBlock html={snippets.controller.html} caption={snippets.controller.file} />
            <CodeBlock html={snippets.page.html} caption={snippets.page.file} />
          </div>
          <p className="hero-note">The page takes its prop types from the controller. Change one, and the other no longer compiles.</p>
        </div>
      </section>

      <section className="principles" aria-labelledby="principles-title">
        <div className="landing-inner">
          <h2 id="principles-title" className="section-label">
            Seven principles
          </h2>
          <ol className="principle-list">
            {PRINCIPLES.map(({ name, text }, index) => (
              <li key={name} className="principle">
                <span className="principle-numeral" aria-hidden="true">
                  {NUMERALS[index]}
                </span>
                <strong>{name}</strong>
                <span className="principle-text">{text}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="chain" aria-labelledby="chain-title">
        <div className="landing-inner">
          <div className="chain-intro">
            <p className="section-label">One type, end to end</p>
            <h2 id="chain-title">A typo anywhere is a compile error.</h2>
            <p>
              The notes table is declared once, in a migration. From there the same type travels through the repository, the controller, the route name and the page,
              down to the error under a form field. Misspell a name at any step and the code no longer compiles.
            </p>
          </div>
          <ol className="chain-list">
            <ChainStep
              number={1}
              title="Migration"
              where={
                <>
                  <code>modules/notes/migrations/</code>
                  <p>
                    The source of truth. Table types are generated from the migrations, never from a live database. <Link href="/docs/migrations">Migrations</Link>
                  </p>
                </>
              }
            >
              <CodeBlock html={snippets.migration.html} caption={snippets.migration.file} />
            </ChainStep>
            <ChainStep
              number={2}
              title="Table type"
              where={
                <>
                  <code>Row&lt;'notes'&gt;</code>
                  <p>
                    Every column of the table, typed. Repositories, controllers and pages all use this one type. <Link href="/docs/queries#table-types">Table types</Link>
                  </p>
                </>
              }
            >
              <CodeBlock html={snippets.tableType.html} caption={snippets.tableType.file} />
            </ChainStep>
            <ChainStep
              number={3}
              title="Repository"
              mistake=".where('user_ud', '=', userId)"
              where={
                <>
                  <code>NoteRepository.ts</code>
                  <p>
                    Kysely&apos;s query builder: every name is checked against the table&apos;s type. Rows in, rows out. <Link href="/docs/queries">Queries</Link>
                  </p>
                </>
              }
            >
              <CodeBlock html={snippets.repository.html} caption={snippets.repository.file} />
            </ChainStep>
            <ChainStep
              number={4}
              title="Controller"
              mistake="{ note: ctx.params.nte }"
              where={
                <>
                  <code>ShowNoteController.ts</code>
                  <p>
                    The route binds the note before <code>handle()</code> runs. A missing one is a 404. <Link href="/docs/routing#route-model-binding">Route model binding</Link>
                  </p>
                </>
              }
            >
              <CodeBlock html={snippets.controllerCall.html} />
            </ChainStep>
            <ChainStep
              number={5}
              title="Route name"
              mistake='<Link route="notes.indx">'
              where={
                <>
                  <code>routes.ts</code>
                  <p>
                    Pages link to routes by name. A name that does not exist does not compile. <Link href="/docs/routing">Routing</Link>
                  </p>
                </>
              }
            >
              <CodeBlock html={snippets.routes.html} caption={snippets.routes.file} />
              <CodeBlock html={snippets.routeLink.html} />
            </ChainStep>
            <ChainStep
              number={6}
              title="Page props"
              mistake="<h1>{note.titel}</h1>"
              where={
                <>
                  <code>views/Show.tsx</code>
                  <p>
                    The page takes its prop types from the controller that renders it. <Link href="/docs/pages">Pages</Link>
                  </p>
                </>
              }
            >
              <CodeBlock html={snippets.pageSignature.html} />
            </ChainStep>
            <ChainStep
              number={7}
              title="Form error"
              mistake="form.errors.titel"
              where={
                <>
                  <code>views/Edit.tsx</code>
                  <p>
                    The form knows its method, URL and field types from the route name, so its errors are typed too. <Link href="/docs/forms">Forms</Link>
                  </p>
                </>
              }
            >
              <CodeBlock html={snippets.form.html} />
            </ChainStep>
          </ol>
        </div>
      </section>

      <ModulesSection />
      <BatteriesSection />
      <SecureSection />
      <TestingSection snippet={snippets.test} />
      <DevtoolsSection />
      <StartSection />
    </div>
  );
}
