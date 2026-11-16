import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { PACKAGES_URL } from '../../links.ts';
import type { ModuleFile } from '../../module-files.ts';
import type { SnippetName } from '../../snippets.ts';
import { Editor } from '../Editor.tsx';
import { Terminal } from '../Terminal.tsx';

interface Battery {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly snippet: SnippetName;
  /** The package the code comes from: a name in `PACKAGES`. */
  readonly package: string;
  readonly docs: { readonly href: string; readonly text: string };
  readonly wide?: boolean;
}

const BATTERIES: readonly Battery[] = [
  {
    id: 'auth',
    title: 'Auth and policies',
    text: 'Sign-in, password reset, email verification and API tokens. Policies stand next to the route, and a misspelt ability does not compile.',
    snippet: 'batteryAuth',
    package: '@marmeon/auth',
    docs: { href: '/docs/authorization', text: 'Authorization' },
    wide: true,
  },
  { id: 'database', title: 'Database', text: 'Queries and transactions: the code makes the registration and dispatches its event in one transaction, which rolls back when it returns an err.', snippet: 'batteryDatabase', package: '@marmeon/database', docs: { href: '/docs/transactions', text: 'Transactions' } },
  { id: 'migrations', title: 'Migrations', text: 'Tables are declared in migrations, and the table types are generated from them.', snippet: 'batteryMigrations', package: '@marmeon/database', docs: { href: '/docs/migrations', text: 'Migrations' } },
  { id: 'validation', title: 'Validation', text: 'Request schemas, with errors typed down to the form field.', snippet: 'batteryValidation', package: '@marmeon/validation', docs: { href: '/docs/validation', text: 'Validation' } },
  { id: 'queue', title: 'Queue', text: 'Jobs as classes, workers and retries.', snippet: 'batteryQueue', package: '@marmeon/queue', docs: { href: '/docs/queues', text: 'Queues' } },
  { id: 'mail', title: 'Mail', text: 'A mail is a class with a React view, written in MJML components with translated text, and a fake for tests.', snippet: 'batteryMail', package: '@marmeon/mail', docs: { href: '/docs/mail', text: 'Mail' } },
  { id: 'scheduler', title: 'Scheduler', text: 'Scheduled tasks in code, next to the module they belong to.', snippet: 'batteryScheduler', package: '@marmeon/scheduler', docs: { href: '/docs/scheduling', text: 'Task scheduling' } },
  { id: 'storage', title: 'Storage', text: 'Disks on the server, in S3 or in memory, signed links that expire, and uploads.', snippet: 'batteryStorage', package: '@marmeon/storage', docs: { href: '/docs/storage', text: 'File storage' } },
  { id: 'modules', title: 'Modules', text: 'A module brings its routes, providers, migrations, views and tests.', snippet: 'batteryModules', package: '@marmeon/core', docs: { href: '/docs/modules#discovery', text: 'Modules and discovery' } },
];

const CHECKS = [
  'Installed packages register themselves',
  'Mail, the queue, storage and the schedule each have a fake for tests',
  <>
    <code>pnpm dev</code> starts the server, and next to it the queue worker and the scheduler your app uses
  </>,
];

/** The module's folder, for the "Modules" card. */
function ModuleFiles({ files }: { files: readonly ModuleFile[] }) {
  return (
    <figure className="file-tree">
      <figcaption>modules/notes/</figcaption>
      <ul aria-label="Files of the notes module">
        {files.map(({ name, folder, role }) => (
          <li key={name}>
            <span className={folder ? 'file-tree-folder' : undefined}>{name}</span>
            <span className="file-tree-role">{role}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** "The backend comes with it": nine cards, each a sentence and a piece of real code, in the design's bento grid. Plain HTML that reads without JavaScript; the terminal's copy button appears once hydrated. */
export function BatteriesSection({ snippets, moduleFiles }: Pick<PageProps<ShowLandingController>, 'snippets' | 'moduleFiles'>) {
  return (
    <section className="batteries landing-light" aria-labelledby="batteries-title">
      <div className="landing-inner">
        <div className="batteries-frame">
          <div className="batteries-head">
            <div>
              <p className="section-label">Batteries included</p>
              <h2 id="batteries-title">
                The backend <span className="serif-accent">comes with it.</span>
              </h2>
            </div>
            <ul className="check-list">
              {CHECKS.map((check, index) => (
                <li key={index}>
                  <span>{check}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="batteries-grid">
            {BATTERIES.map(({ id, title, text, snippet, package: packageName, docs, wide }) => {
              const { file, html } = snippets[snippet];
              if (file === undefined) throw new Error(`The landing's battery snippet "${snippet}" has no file name.`);
              return (
                <article key={id} className={`card battery${wide ? ' battery--wide' : ''}`}>
                  <div className="battery-head">
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                  <Editor label={`${title}: ${file.split('/').at(-1)}`} files={[{ name: file, html }]} headingLevel={4} className="battery-editor" />
                  {id === 'modules' && (
                    <div className="battery-extra">
                      <ModuleFiles files={moduleFiles} />
                      <Terminal commands={['pnpm add -E @marmeon/redis@<version of your app>']} label="An installed package registers itself" />
                    </div>
                  )}
                  <p className="battery-foot">
                    <code>{packageName}</code>
                    <Link href={docs.href}>{docs.text}</Link>
                  </p>
                </article>
              );
            })}
          </div>
          <p className="batteries-all">
            <Link href={PACKAGES_URL}>All packages</Link>
          </p>
        </div>
      </div>
    </section>
  );
}
