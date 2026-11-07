import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { ReactNode } from 'react';
import type { ChainStepId } from '../../chain.ts';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { CodeBlock } from '../CodeBlock.tsx';
import { Editor } from '../Editor.tsx';
import { Tabs } from '../Tabs.tsx';

/** What a step says about itself. */
const WHERE: Record<ChainStepId, { readonly text: ReactNode }> = {
  migration: {
    text: (
      <>
        The source of truth. Table types are generated from the migrations, never from a live database. <Link href="/docs/migrations">Migrations</Link>
      </>
    ),
  },
  row: {
    text: (
      <>
        Every column of the table, typed. Repositories, controllers and pages all use this one type. <Link href="/docs/queries#table-types">Table types</Link>
      </>
    ),
  },
  repository: {
    text: (
      <>
        Kysely&apos;s query builder: every name is checked against the table&apos;s type. Rows in, rows out. <Link href="/docs/queries">Queries</Link>
      </>
    ),
  },
  controller: {
    text: (
      <>
        The route binds the note before <code>handle()</code> runs. A missing one is a 404. <Link href="/docs/routing#route-model-binding">Route model binding</Link>
      </>
    ),
  },
  route: {
    text: (
      <>
        Pages link to routes by name. A name that does not exist does not compile. <Link href="/docs/routing">Routing</Link>
      </>
    ),
  },
  props: {
    text: (
      <>
        The page takes its prop types from the controller that renders it. <Link href="/docs/pages">Pages</Link>
      </>
    ),
  },
  form: {
    text: (
      <>
        The form knows its method, URL and field types from the route name, so its errors are typed too. <Link href="/docs/forms">Forms</Link>
      </>
    ),
  },
};

/**
 * "A typo anywhere is a compile error": one type followed in seven steps from the migration to the form error. A step bar once hydrated, seven
 * steps one under the other before — each with its code, the misspelt line and what the compiler says about it.
 */
export function ChainSection({ snippets, chain }: Pick<PageProps<ShowLandingController>, 'snippets' | 'chain'>) {
  return (
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
        <Tabs
          label="Steps of the chain"
          idPrefix="chain"
          stackAs="ol"
          itemClassName="chain-step"
          className="chain-tabs"
          items={chain.map((step, index) => {
            const { text } = WHERE[step.id];
            return {
              id: step.id,
              label: (
                <>
                  <span className="chain-number">{index + 1}</span> {step.title}
                </>
              ),
              content: (
                <div className="chain-body">
                  <p className="chain-text">{text}</p>
                  <Editor
                    label={`${step.title}: ${step.file}`}
                    layout="split"
                    headingLevel={4}
                    className="chain-editor"
                    files={[{ name: step.file, html: snippets[step.snippet].html }]}
                    footer={
                      <>
                        <div className="chain-mistake">
                          <span className="visually-hidden">This does not compile: </span>
                          <CodeBlock copy={false} html={step.mistake} />
                        </div>
                        <p className="chain-error">
                          <span className="chain-error-code">error {step.error.code}:</span> {step.error.message}
                        </p>
                      </>
                    }
                  />
                </div>
              ),
            };
          })}
        />
      </div>
    </section>
  );
}
