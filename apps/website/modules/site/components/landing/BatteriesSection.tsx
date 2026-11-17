import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { ReactNode } from 'react';
import type { ShowLandingController } from '../../controllers/ShowLandingController.ts';
import { JOBS, MAIL, NOTES_TABLE, SCHEDULE, STORAGE, VALIDATION } from '../../batteries.ts';
import { PACKAGES_URL } from '../../links.ts';
import type { ModuleFile } from '../../module-files.ts';
import { Editor } from '../Editor.tsx';

interface Battery {
  readonly id: 'auth' | 'database' | 'queue' | 'mail' | 'validation' | 'scheduler' | 'modules' | 'storage';
  readonly title: string;
  readonly text: string;
  /** The package the card is about: a name in `PACKAGES`. */
  readonly package: string;
  readonly docs: { readonly href: string; readonly text: string };
  readonly wide?: boolean;
}

const BATTERIES: readonly Battery[] = [
  {
    id: 'auth',
    title: 'Auth and policies',
    text: 'Sign-in, password reset, email verification and API tokens. Policies stand next to the route, and a misspelt ability does not compile.',
    package: '@marmeon/auth',
    docs: { href: '/docs/authorization', text: 'Authorization' },
    wide: true,
  },
  { id: 'database', title: 'Database and migrations', text: 'Tables are declared in migrations, and the table types are generated from them. A transaction rolls back when the code returns an err.', package: '@marmeon/database', docs: { href: '/docs/migrations', text: 'Migrations' } },
  { id: 'queue', title: 'Queue', text: 'Jobs as classes, workers and retries. The worker starts with the dev server.', package: '@marmeon/queue', docs: { href: '/docs/queues', text: 'Queues' } },
  { id: 'mail', title: 'Mail', text: 'A mail is a class with a React view, written in MJML components with translated text, and a fake for tests.', package: '@marmeon/mail', docs: { href: '/docs/mail', text: 'Mail' } },
  { id: 'validation', title: 'Validation', text: "Rules with messages in the request's language. Errors are typed down to the field.", package: '@marmeon/validation', docs: { href: '/docs/validation', text: 'Validation' } },
  { id: 'scheduler', title: 'Scheduler', text: 'Scheduled tasks in code, next to the module they belong to.', package: '@marmeon/scheduler', docs: { href: '/docs/scheduling', text: 'Task scheduling' } },
  { id: 'modules', title: 'Modules', text: 'A module brings its routes, providers, migrations, views and tests.', package: '@marmeon/core', docs: { href: '/docs/modules#discovery', text: 'Modules and discovery' } },
  { id: 'storage', title: 'Storage', text: 'Disks on the server, in S3 or in memory, signed links that expire, and uploads.', package: '@marmeon/storage', docs: { href: '/docs/storage', text: 'File storage' } },
];

const CHECKS = [
  'Installed packages register themselves',
  'Mail, the queue, storage and the schedule each have a fake for tests',
  <>
    <code>pnpm dev</code> starts the server, and next to it the queue worker and the scheduler your app uses
  </>,
];

/** The notes table: a header, then a row per column. */
function TableArt() {
  return (
    <table className="art-table">
      <thead>
        <tr>
          <th scope="col">{NOTES_TABLE.name}</th>
          <td>table</td>
        </tr>
      </thead>
      <tbody>
        {NOTES_TABLE.rows.map(({ name, type }) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Three jobs with a dot for their state; the state is also written, so the colour carries nothing alone. */
function QueueArt() {
  return (
    <ul className="art-jobs" aria-label="Jobs in the queue">
      {JOBS.map(({ name, status, state }) => (
        <li key={name}>
          <span className={`art-dot art-dot--${status}`} aria-hidden="true" />
          <span className="art-job-name">{name}</span>
          <span className="art-job-state">{state}</span>
        </li>
      ))}
    </ul>
  );
}

/** A mail: the address and subject, two lines of body and the button. */
function MailArt() {
  return (
    <figure className="art-mail" aria-label="A mail with a button">
      <div className="art-mail-head">
        <span>
          <b>To</b> {MAIL.to}
        </span>
        <span>
          <b>Subject</b> {MAIL.subject}
        </span>
      </div>
      <div className="art-mail-body" aria-hidden="true">
        <span className="art-line" />
        <span className="art-line art-line--short" />
        <span className="art-mail-button">{MAIL.button}</span>
      </div>
    </figure>
  );
}

/** A field with a value that is too long, and the error under it. The error is plain text tied by `aria-describedby`: the picture does not announce itself. */
function ValidationArt() {
  return (
    <div className="art-field">
      <label htmlFor="battery-validation-title">{VALIDATION.label}</label>
      <input id="battery-validation-title" value={VALIDATION.value} readOnly aria-invalid="true" aria-describedby="battery-validation-error" />
      <small id="battery-validation-error">{VALIDATION.error}</small>
    </div>
  );
}

function ScheduleArt() {
  return (
    <ul className="art-schedule" aria-label="Scheduled tasks">
      {SCHEDULE.map(({ when, what }) => (
        <li key={what}>
          <span className="art-when">{when}</span>
          <span>{what}</span>
        </li>
      ))}
    </ul>
  );
}

/** The folder of the notes module: the names of its files and folders. */
function ModuleArt({ files }: { files: readonly ModuleFile[] }) {
  return (
    <figure className="art-tree">
      <figcaption>modules/notes/</figcaption>
      <ul aria-label="Files of the notes module">
        {files.map(({ name, folder }) => (
          <li key={name} className={folder ? 'art-tree-folder' : undefined}>
            {name}
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Two disks, one of them chosen, and a file with the time its link holds. */
function StorageArt() {
  return (
    <div className="art-storage">
      <ul aria-label="Disks">
        {STORAGE.disks.map((disk) => (
          <li key={disk} className={disk === STORAGE.active ? 'art-disk art-disk--on' : 'art-disk'}>
            {disk}
          </li>
        ))}
      </ul>
      <p className="art-signed">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 16V4M6 10l6-6 6 6M4 20h16" />
        </svg>
        <span>
          {STORAGE.key} · signed for {STORAGE.minutes} min
        </span>
      </p>
    </div>
  );
}

/** "Everything your app needs, already wired together": eight cards in the design's bento grid — the Auth card with the policy's code, the others with a small picture of what the package does. Plain HTML that reads without JavaScript. */
export function BatteriesSection({ snippets, moduleFiles }: Pick<PageProps<ShowLandingController>, 'snippets' | 'moduleFiles'>) {
  const { file, html } = snippets.batteryAuth;
  if (file === undefined) throw new Error('The landing\'s battery snippet "batteryAuth" has no file name.');
  const pictures: Record<Battery['id'], ReactNode> = {
    auth: <Editor label={`Auth and policies: ${file.split('/').at(-1)}`} files={[{ name: file, html }]} headingLevel={4} className="battery-editor" />,
    database: <TableArt />,
    queue: <QueueArt />,
    mail: <MailArt />,
    validation: <ValidationArt />,
    scheduler: <ScheduleArt />,
    modules: <ModuleArt files={moduleFiles} />,
    storage: <StorageArt />,
  };
  return (
    <section className="batteries landing-light" aria-labelledby="batteries-title">
      <div className="landing-inner">
        <div className="batteries-frame">
          <div className="batteries-head">
            <div>
              <p className="section-label">Batteries included</p>
              <h2 id="batteries-title">
                Everything your app needs, <span className="serif-accent">already wired together.</span>
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
            {BATTERIES.map(({ id, title, text, package: packageName, docs, wide }) => (
              <article key={id} className={`card battery${wide ? ' battery--wide' : ''}`}>
                <div className="battery-head">
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
                {pictures[id]}
                <p className="battery-foot">
                  <code>{packageName}</code>
                  <Link href={docs.href}>{docs.text}</Link>
                </p>
              </article>
            ))}
          </div>
          <p className="batteries-all">
            <Link href={PACKAGES_URL}>All packages</Link>
          </p>
        </div>
      </div>
    </section>
  );
}
