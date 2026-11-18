/** Where a package belongs: in a new app, an addition for what an app needs, or the tools around it. */
export type PackageGroup = 'app' | 'add' | 'tooling';

/** The landing's three groups of packages, in order: the title and a note under it. The note names packages, so it travels as props, not as source of the client bundle. */
export const PACKAGE_GROUPS: readonly { readonly group: PackageGroup; readonly title: string; readonly note?: string }[] = [
  { group: 'app', title: 'In every new app' },
  { group: 'add', title: 'Add when you need it' },
  { group: 'tooling', title: 'Dev tools', note: "@marmeon/vite, @marmeon/testing and @marmeon/devtools are in every new app's dev dependencies; create-marmeon starts a new app." },
];

export interface PackageEntry {
  /** The name on npm, as in the package's `package.json`. */
  readonly name: string;
  /** The slug of the docs page that explains it (`docs/<slug>.md`). */
  readonly docs: string;
  readonly group: PackageGroup;
  readonly text: string;
}

/** Every package of the repository, once: the landing lists them from here (the controller hands the list to the page, so the browser's bundle never imports this file), and a test compares the names with `packages/*`. */
export const PACKAGES: readonly PackageEntry[] = [
  { name: '@marmeon/core', docs: 'modules', group: 'app', text: 'App, modules, container, config, events, clock.' },
  { name: 'marmeon', docs: 'console', group: 'app', text: 'The CLI: dev, build, start, generators, tinker.' },
  { name: '@marmeon/router', docs: 'routing', group: 'app', text: 'Routes, invokable controllers, request schemas, route model binding, middleware.' },
  { name: '@marmeon/http', docs: 'responses', group: 'app', text: 'Pages and props, redirects, signed URLs, cookies.' },
  { name: '@marmeon/server', docs: 'lifecycle', group: 'app', text: 'HTTP server, SSR, health checks, graceful stop.' },
  { name: '@marmeon/session', docs: 'session', group: 'app', text: 'Sessions, flash data, CSRF.' },
  { name: '@marmeon/encryption', docs: 'encryption', group: 'app', text: 'Encryption with APP_KEY and key rotation.' },
  { name: '@marmeon/validation', docs: 'validation', group: 'app', text: "Validation rules, with messages in the request's language." },
  { name: '@marmeon/i18n', docs: 'localization', group: 'app', text: "Translations, the request's language and formatting." },
  { name: '@marmeon/database', docs: 'database', group: 'app', text: 'Migrations, table types, repositories, factories, transactions, pagination.' },
  { name: '@marmeon/cache', docs: 'cache', group: 'app', text: 'Cache, atomic locks, rate limits.' },
  { name: '@marmeon/auth', docs: 'authentication', group: 'app', text: 'Sign-in, hashing, password reset, email verification, API tokens, policies.' },
  { name: '@marmeon/mail', docs: 'mail', group: 'app', text: 'Mails as classes, queued sending, a fake for tests.' },
  { name: '@marmeon/queue', docs: 'queues', group: 'app', text: 'Jobs, workers, retries, a fake for tests.' },
  { name: '@marmeon/scheduler', docs: 'scheduling', group: 'app', text: 'Scheduled tasks, with a fake for tests.' },
  { name: '@marmeon/log', docs: 'logging', group: 'app', text: 'The logger: readable in development, JSON in production.' },
  { name: '@marmeon/react', docs: 'pages', group: 'app', text: 'Pages, layouts, <Link>, forms, islands, dialogs.' },
  { name: '@marmeon/storage', docs: 'storage', group: 'app', text: 'Local and S3 disks, signed URLs, uploads.' },
  { name: '@marmeon/live', docs: 'realtime', group: 'app', text: 'Pages reload their data when the server hints a change.' },
  { name: '@marmeon/notifications', docs: 'notifications', group: 'app', text: 'Mail, database and live notifications.' },
  { name: '@marmeon/fetch', docs: 'http-client', group: 'app', text: 'Outgoing requests that refuse private addresses, with a fake for tests.' },
  { name: '@marmeon/chat-notifications', docs: 'chat-notifications', group: 'add', text: 'Slack, Discord and Teams messages through webhooks, with a fake for tests.' },
  { name: '@marmeon/redis', docs: 'redis', group: 'add', text: 'Redis connections for the cache, sessions, the queue and live updates.' },
  { name: '@marmeon/table', docs: 'tables', group: 'add', text: 'Server-driven data tables with sorting, filters, actions, CSV export.' },
  { name: '@marmeon/otel', docs: 'observability', group: 'add', text: 'OpenTelemetry traces.' },
  { name: '@marmeon/vite', docs: 'vite', group: 'tooling', text: 'The plugin that also keeps server code out of the browser.' },
  { name: '@marmeon/testing', docs: 'testing', group: 'tooling', text: 'createTestApp(), assertions, fakes.' },
  { name: '@marmeon/devtools', docs: 'devtools', group: 'tooling', text: 'Records requests, queries, jobs and mails. Development only.' },
  { name: 'create-marmeon', docs: 'installation', group: 'tooling', text: 'The creator behind pnpm create marmeon.' },
];
