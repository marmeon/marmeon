/** What `marmeon add` knows of one framework package. */
export interface FrameworkPackage {
  /** Installed as a development dependency (the app's tooling, not its runtime). */
  readonly dev: boolean;
  /** Ships migrations (`stubs/migrations`), which `marmeon publish` copies into the app. */
  readonly migrations: boolean;
  /** The slug of its page for `marmeon docs <slug>`. */
  readonly docs: string;
}

/**
 * Every published framework package `marmeon add` may install, by full name (`create-marmeon` is not a dependency of an app). The only
 * names that ever reach a package manager's argument list; a test holds it to the packages of the repository.
 */
export const FRAMEWORK_PACKAGES: ReadonlyMap<string, FrameworkPackage> = new Map<string, FrameworkPackage>([
  ['marmeon', { dev: false, migrations: false, docs: 'installation' }],
  ['@marmeon/auth', { dev: false, migrations: true, docs: 'authentication' }],
  ['@marmeon/cache', { dev: false, migrations: true, docs: 'cache' }],
  ['@marmeon/core', { dev: false, migrations: false, docs: 'container' }],
  ['@marmeon/database', { dev: false, migrations: false, docs: 'database' }],
  ['@marmeon/devtools', { dev: true, migrations: false, docs: 'devtools' }],
  ['@marmeon/encryption', { dev: false, migrations: false, docs: 'encryption' }],
  ['@marmeon/fetch', { dev: false, migrations: false, docs: 'http-client' }],
  ['@marmeon/http', { dev: false, migrations: false, docs: 'requests' }],
  ['@marmeon/i18n', { dev: false, migrations: false, docs: 'localization' }],
  ['@marmeon/live', { dev: false, migrations: true, docs: 'realtime' }],
  ['@marmeon/log', { dev: false, migrations: false, docs: 'logging' }],
  ['@marmeon/mail', { dev: false, migrations: false, docs: 'mail' }],
  ['@marmeon/notifications', { dev: false, migrations: true, docs: 'notifications' }],
  ['@marmeon/otel', { dev: false, migrations: false, docs: 'observability' }],
  ['@marmeon/queue', { dev: false, migrations: true, docs: 'queues' }],
  ['@marmeon/react', { dev: false, migrations: false, docs: 'pages' }],
  ['@marmeon/redis', { dev: false, migrations: false, docs: 'redis' }],
  ['@marmeon/router', { dev: false, migrations: false, docs: 'navigation' }],
  ['@marmeon/scheduler', { dev: false, migrations: false, docs: 'scheduling' }],
  ['@marmeon/server', { dev: false, migrations: false, docs: 'deployment' }],
  ['@marmeon/session', { dev: false, migrations: true, docs: 'session' }],
  ['@marmeon/storage', { dev: false, migrations: true, docs: 'storage' }],
  ['@marmeon/table', { dev: false, migrations: false, docs: 'tables' }],
  ['@marmeon/testing', { dev: true, migrations: false, docs: 'testing' }],
  ['@marmeon/validation', { dev: false, migrations: false, docs: 'validation' }],
  ['@marmeon/vite', { dev: true, migrations: false, docs: 'vite' }],
]);
