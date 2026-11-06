import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import { CHAIN, mistakeLine } from '../../chain.ts';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { ChainStep } from '../ChainStep.tsx';
import { CodeBlock } from '../CodeBlock.tsx';

/** "A typo anywhere is a compile error": one type followed in seven steps from the migration to the form error. */
export function ChainSection({ snippets }: Pick<PageProps<ShowLandingController>, 'snippets'>) {
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
        <ol className="chain-list">
          <ChainStep
            number={1}
            title="Migration"
            mistake={mistakeLine(CHAIN[0]!)}
            where={
              <>
                <code>modules/notes/migrations/</code>
                <p>
                  The source of truth. Table types are generated from the migrations, never from a live database. <Link href="/docs/migrations">Migrations</Link>
                </p>
              </>
            }
          >
            <CodeBlock copy={false} html={snippets.migration.html} caption={snippets.migration.file} />
          </ChainStep>
          <ChainStep
            number={2}
            title="Table type"
            mistake={mistakeLine(CHAIN[1]!)}
            where={
              <>
                <code>Row&lt;'notes'&gt;</code>
                <p>
                  Every column of the table, typed. Repositories, controllers and pages all use this one type. <Link href="/docs/queries#table-types">Table types</Link>
                </p>
              </>
            }
          >
            <CodeBlock copy={false} html={snippets.tableType.html} caption={snippets.tableType.file} />
          </ChainStep>
          <ChainStep
            number={3}
            title="Repository"
            mistake={mistakeLine(CHAIN[2]!)}
            where={
              <>
                <code>NoteRepository.ts</code>
                <p>
                  Kysely&apos;s query builder: every name is checked against the table&apos;s type. Rows in, rows out. <Link href="/docs/queries">Queries</Link>
                </p>
              </>
            }
          >
            <CodeBlock copy={false} html={snippets.repository.html} caption={snippets.repository.file} />
          </ChainStep>
          <ChainStep
            number={4}
            title="Controller"
            mistake={mistakeLine(CHAIN[3]!)}
            where={
              <>
                <code>ShowNoteController.ts</code>
                <p>
                  The route binds the note before <code>handle()</code> runs. A missing one is a 404. <Link href="/docs/routing#route-model-binding">Route model binding</Link>
                </p>
              </>
            }
          >
            <CodeBlock copy={false} html={snippets.controllerCall.html} />
          </ChainStep>
          <ChainStep
            number={5}
            title="Route name"
            mistake={mistakeLine(CHAIN[4]!)}
            where={
              <>
                <code>routes.ts</code>
                <p>
                  Pages link to routes by name. A name that does not exist does not compile. <Link href="/docs/routing">Routing</Link>
                </p>
              </>
            }
          >
            <CodeBlock copy={false} html={snippets.routes.html} caption={snippets.routes.file} />
            <CodeBlock copy={false} html={snippets.routeLink.html} />
          </ChainStep>
          <ChainStep
            number={6}
            title="Page props"
            mistake={mistakeLine(CHAIN[5]!)}
            where={
              <>
                <code>views/Show.tsx</code>
                <p>
                  The page takes its prop types from the controller that renders it. <Link href="/docs/pages">Pages</Link>
                </p>
              </>
            }
          >
            <CodeBlock copy={false} html={snippets.pageSignature.html} />
          </ChainStep>
          <ChainStep
            number={7}
            title="Form error"
            mistake={mistakeLine(CHAIN[6]!)}
            where={
              <>
                <code>views/Form.tsx</code>
                <p>
                  The form knows its method, URL and field types from the route name, so its errors are typed too. <Link href="/docs/forms">Forms</Link>
                </p>
              </>
            }
          >
            <CodeBlock copy={false} html={snippets.form.html} />
          </ChainStep>
        </ol>
      </div>
    </section>
  );
}
