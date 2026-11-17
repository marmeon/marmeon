import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { ReactNode } from 'react';
import type { ChainStepId } from '../../chain.ts';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { CodeBlock } from '../CodeBlock.tsx';
import { Tabs } from '../Tabs.tsx';

/** What a step says about itself, and the docs page that shows it. */
const WHERE: Record<ChainStepId, { readonly text: ReactNode; readonly doc: { readonly href: string; readonly label: string } }> = {
  migration: {
    text: 'The source of truth. Table types are generated from the migrations, never from a live database.',
    doc: { href: '/docs/migrations', label: 'Migrations' },
  },
  row: {
    text: 'Every column of the table, typed. Repositories, controllers and pages all use this one type.',
    doc: { href: '/docs/queries#table-types', label: 'Table types' },
  },
  repository: {
    text: "Kysely's query builder: every name is checked against the table's type. Rows in, rows out.",
    doc: { href: '/docs/queries', label: 'Queries' },
  },
  controller: {
    text: (
      <>
        The route binds the note before <code>handle()</code> runs. A missing one is a 404.
      </>
    ),
    doc: { href: '/docs/routing#route-model-binding', label: 'Route model binding' },
  },
  route: {
    text: 'Pages link to routes by name. A name that does not exist does not compile.',
    doc: { href: '/docs/routing', label: 'Routing' },
  },
  props: {
    text: 'The page takes its prop types from the controller that renders it.',
    doc: { href: '/docs/pages', label: 'Pages' },
  },
  form: {
    text: 'The form knows its method, URL and field types from the route name, so its errors are typed too.',
    doc: { href: '/docs/forms', label: 'Forms' },
  },
};

/**
 * "A typo anywhere is a compile error": one type followed from the migration to the form error. A step bar once hydrated, the steps
 * one under the other before — each with its code, the misspelt line and what the compiler says about it.
 */
export function ChainSection({ snippets, chain }: Pick<PageProps<ShowLandingController>, 'snippets' | 'chain'>) {
  return (
    <section className="chain stage" aria-labelledby="chain-title">
      <div className="landing-inner">
        <div className="chain-frame">
          <div className="chain-intro">
            <div>
              <p className="section-label">One type, end to end</p>
              <h2 id="chain-title">
                A typo anywhere is <span className="serif-accent">a compile error.</span>
              </h2>
            </div>
            <p>
              The notes table is declared once, in a migration. The same type travels through the repository, the controller, the route name and the page, down to the error under a form field.
            </p>
          </div>
          <Tabs
            label="Steps of the chain"
            idPrefix="chain"
            stackAs="ol"
            itemClassName="chain-step"
            className="chain-tabs"
            items={chain.map((step, index) => {
              const { text, doc } = WHERE[step.id];
              return {
                id: step.id,
                label: (
                  <>
                    <span className="chain-number">
                      {index + 1} / {chain.length}
                    </span>{' '}
                    {step.title}
                  </>
                ),
                content: (
                  <div className="chain-body">
                    <div className="chain-window" role="group" aria-label={`${step.title}: ${step.file}`}>
                      <div className="chain-window-bar">
                        <h4 className="editor-name">{step.file}</h4>
                        <span className="chain-compiles">compiles</span>
                      </div>
                      <CodeBlock copy={false} html={snippets[step.snippet].html} />
                    </div>
                    <div className="chain-side">
                      <div className="chain-card">
                        <p className="chain-card-title">{`${index + 1}. ${step.title}`}</p>
                        <p className="chain-text">{text}</p>
                        <Link href={doc.href} className="chain-doc">
                          Docs: {doc.label}
                        </Link>
                      </div>
                      <div className="chain-fail">
                        <p className="chain-fail-title">This does not compile</p>
                        <div className="chain-mistake">
                          <CodeBlock copy={false} html={step.mistake} />
                        </div>
                        <p className="chain-error">{`error ${step.error.code}: ${step.error.message}`}</p>
                      </div>
                    </div>
                  </div>
                ),
              };
            })}
          />
        </div>
      </div>
    </section>
  );
}
