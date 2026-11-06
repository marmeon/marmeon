import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { PACKAGES_URL } from '../../links.ts';
import { PACKAGE_GROUPS, PACKAGES } from '../../packages.ts';
import type { SnippetName } from '../../snippets.ts';
import { Editor } from '../Editor.tsx';
import { Tabs } from '../Tabs.tsx';
import { Terminal } from '../Terminal.tsx';

interface Battery {
  readonly id: string;
  readonly label: string;
  readonly snippet: SnippetName;
  readonly docs: { readonly href: string; readonly text: string };
}

const BATTERIES: readonly Battery[] = [
  { id: 'auth', label: 'Auth', snippet: 'batteryAuth', docs: { href: '/docs/authorization', text: 'Authorization' } },
  { id: 'database', label: 'Database', snippet: 'batteryDatabase', docs: { href: '/docs/queries', text: 'Queries' } },
  { id: 'migrations', label: 'Migrations', snippet: 'batteryMigrations', docs: { href: '/docs/migrations', text: 'Migrations' } },
  { id: 'validation', label: 'Validation', snippet: 'batteryValidation', docs: { href: '/docs/validation', text: 'Validation' } },
  { id: 'queue', label: 'Queue', snippet: 'batteryQueue', docs: { href: '/docs/queues', text: 'Queues' } },
  { id: 'mail', label: 'Mail', snippet: 'batteryMail', docs: { href: '/docs/mail', text: 'Mail' } },
  { id: 'scheduler', label: 'Scheduler', snippet: 'batteryScheduler', docs: { href: '/docs/scheduling', text: 'Task scheduling' } },
  { id: 'storage', label: 'Storage', snippet: 'batteryStorage', docs: { href: '/docs/storage', text: 'File storage' } },
  { id: 'modules', label: 'Modules', snippet: 'batteryModules', docs: { href: '/docs/modules#discovery', text: 'Modules and discovery' } },
];

const MODULE_FILES: { name: string; folder?: boolean; role: string }[] = [
  { name: 'routes.ts', role: 'routes and their names' },
  { name: 'controllers/', folder: true, role: 'one class per endpoint' },
  { name: 'views/', folder: true, role: 'React pages' },
  { name: 'migrations/', folder: true, role: "the module's tables" },
  { name: 'jobs/', folder: true, role: 'queued work' },
  { name: 'notes.test.ts', role: 'tests, next to the code' },
  { name: 'index.ts', role: 'the definition, and what other modules may import' },
];

const CHECKS = [
  'Installed packages register themselves',
  'Mail, the queue, storage and the schedule each have a fake for tests',
  <>
    <code>pnpm dev</code> starts the server, the worker and the scheduler together
  </>,
];

/** The module's folder, for the "Modules" tab. */
function ModuleFiles() {
  return (
    <figure className="file-tree">
      <figcaption>modules/notes/</figcaption>
      <ul aria-label="Files of the notes module">
        {MODULE_FILES.map(({ name, folder, role }) => (
          <li key={name}>
            <span className={folder ? 'file-tree-folder' : undefined}>{name}</span>
            <span className="file-tree-role">{role}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Every package of the framework with a link to its page, in groups, from `PACKAGES`. */
function PackageList() {
  return (
    <div className="package-list">
      <h3 className="group-label">{`${PACKAGES.length} packages, one version`}</h3>
      {PACKAGE_GROUPS.map(({ group, title }) => (
        <div key={group} className="package-group">
          <h4 className="group-label group-label--small">{title}</h4>
          <ul className="package-grid" aria-label={title}>
            {PACKAGES.filter((entry) => entry.group === group).map(({ name, docs, text }) => {
              const scope = name.startsWith('@marmeon/') ? '@marmeon/' : '';
              return (
                <li key={name}>
                  <Link href={`/docs/${docs}`}>
                    <code>
                      {scope && <span className="package-scope">{scope}</span>}
                      {name.slice(scope.length)}
                    </code>
                  </Link>
                  <span>{text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** "The backend comes with it": one tab per package, each with a piece of real code, and the checks that hold the packages together. */
export function BatteriesSection({ snippets }: Pick<PageProps<ShowLandingController>, 'snippets'>) {
  return (
    <section className="batteries" aria-labelledby="batteries-title">
      <div className="landing-inner batteries-inner">
        <div className="batteries-head">
          <div className="section-intro">
            <p className="section-label">Batteries included</p>
            <h2 id="batteries-title">The backend comes with it.</h2>
            <p>
              Authorization, a database layer, validation, a queue, mail, a scheduler and file storage are packages of the framework, released together and wired to each
              other. <Link href={PACKAGES_URL}>All packages</Link>
            </p>
          </div>
          <ul className="check-list">
            {CHECKS.map((check, index) => (
              <li key={index}>
                <span>{check}</span>
              </li>
            ))}
          </ul>
        </div>
        <Tabs
          label="Packages of the framework"
          idPrefix="batteries"
          headingLevel={3}
          className="batteries-tabs"
          itemClassName="battery"
          items={BATTERIES.map(({ id, label, snippet, docs }) => {
            const { file, html } = snippets[snippet];
            return {
              id,
              label,
              content: (
                <>
                  <Editor label={`${label}: ${file!.split('/').at(-1)!}`} files={[{ name: file!, html }]} headingLevel={4} />
                  {id === 'modules' && (
                    <div className="battery-extra">
                      <ModuleFiles />
                      <Terminal commands={['pnpm add @marmeon/redis']} />
                    </div>
                  )}
                  <p className="battery-docs">
                    <Link href={docs.href}>{docs.text} →</Link>
                  </p>
                </>
              ),
            };
          })}
        />
        <PackageList />
      </div>
    </section>
  );
}
