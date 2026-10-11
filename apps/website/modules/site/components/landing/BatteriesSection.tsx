import { Link } from '@marmeon/react';
import { PACKAGES_URL } from '../../links.ts';

/** `name` is the package's name without the `@marmeon/` scope; `marmeon` is the CLI and has none. */
const IN_EVERY_APP: { name: string; scoped?: false; text: string }[] = [
  { name: 'core', text: 'App, modules, container, config, events, clock.' },
  { name: 'marmeon', scoped: false, text: 'The CLI: dev, build, start, generators, tinker.' },
  { name: 'router', text: 'Routes, invokable controllers, request schemas, route model binding, middleware.' },
  { name: 'http', text: 'Pages and props, redirects, signed URLs, cookies.' },
  { name: 'server', text: 'HTTP server, SSR, health checks, graceful stop.' },
  { name: 'session', text: 'Sessions, flash data, CSRF.' },
  { name: 'validation', text: "Validation rules, with messages in the request's language." },
  { name: 'i18n', text: "Translations, the request's language and formatting." },
  { name: 'database', text: 'Migrations, table types, repositories, factories, transactions, pagination.' },
  { name: 'cache', text: 'Cache, atomic locks, rate limits.' },
  { name: 'auth', text: 'Sign-in, hashing, password reset, email verification, API tokens, policies.' },
  { name: 'mail', text: 'Mails as classes, queued sending, a fake for tests.' },
  { name: 'queue', text: 'Jobs, workers, retries, a fake for tests.' },
  { name: 'scheduler', text: 'Scheduled tasks, with a fake for tests.' },
  { name: 'log', text: 'The logger: readable in development, JSON in production.' },
  { name: 'react', text: 'Pages, layouts, <Link>, forms, islands, dialogs.' },
];
const DEV_DEPENDENCIES: typeof IN_EVERY_APP = [
  { name: 'vite', text: 'The plugin that also keeps server code out of the browser.' },
  { name: 'testing', text: 'createTestApp(), assertions, fakes.' },
  { name: 'devtools', text: 'Records requests, queries, jobs and mails. Development only.' },
];
const ADDED: typeof IN_EVERY_APP = [
  { name: 'redis', text: 'Redis connections for the cache, sessions, the queue and live updates.' },
  { name: 'storage', text: 'Local and S3 disks, signed URLs, uploads.' },
  { name: 'live', text: 'Pages reload their data when the server hints a change.' },
  { name: 'notifications', text: 'Mail, database and live notifications.' },
  { name: 'table', text: 'Server-driven data tables with sorting, filters, actions, CSV export.' },
  { name: 'otel', text: 'OpenTelemetry traces.' },
];

function PackageList({ packages, label, added }: { packages: typeof IN_EVERY_APP; label: string; added?: boolean }) {
  return (
    <ul className={added ? 'package-grid package-grid--added' : 'package-grid'} aria-label={label}>
      {packages.map(({ name, scoped, text }) => (
        <li key={name}>
          <code>
            {scoped === false ? null : <span className="package-scope">@marmeon/</span>}
            {name}
          </code>
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Wired together, behind contracts": the packages, grouped by whether a new app has them. */
export function BatteriesSection() {
  return (
    <section className="batteries" aria-labelledby="batteries-title">
      <div className="landing-inner">
        <div className="section-intro section-intro--wide">
          <p className="section-label">Batteries included</p>
          <h2 id="batteries-title">Wired together, behind contracts.</h2>
          <p>
            Mail, the queue, notifications and storage have several drivers and a fake for tests. Every package is released together, always at the same
            version. <Link href={PACKAGES_URL}>All packages</Link>
          </p>
        </div>
        <h3 className="group-label">In every new app</h3>
        <PackageList packages={IN_EVERY_APP} label="Packages in every new app" />
        <h4 className="group-label group-label--small">Dev dependencies</h4>
        <PackageList packages={DEV_DEPENDENCIES} label="Dev dependencies of a new app" />
        <h3 className="group-label">Add when you need it</h3>
        <PackageList packages={ADDED} label="Packages to add when you need them" added />
      </div>
    </section>
  );
}
