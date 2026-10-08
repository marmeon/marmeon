/**
 * The navigation of the docs: the sections with their pages (`/docs/<slug>`), then every framework package (a directory under
 * `packages/` with a README.md) in exactly one group. The groups are typed against `PACKAGES` — a name that is no package, or a
 * package in no group, is a compile error — and both are checked against the repository when the app boots: a page or package
 * without an entry here, or an entry without its file, stops the start.
 */
export const PACKAGES = [
  'auth',
  'cache',
  'cli',
  'core',
  'create-marmeon',
  'database',
  'devtools',
  'encryption',
  'http',
  'i18n',
  'live',
  'log',
  'mail',
  'notifications',
  'otel',
  'queue',
  'react',
  'redis',
  'router',
  'scheduler',
  'server',
  'session',
  'storage',
  'table',
  'testing',
  'validation',
  'vite',
] as const;

export type PackageName = (typeof PACKAGES)[number];

/** A page of the docs: `/docs/<slug>`, its file `docs/<slug>.md` — or a policy at the root (`file`). */
export interface DocsPageEntry {
  readonly slug: string;
  /** Its name in the navigation (the page's title is its `#` heading). */
  readonly label: string;
  /** A file at the root instead of `docs/<slug>.md`: `UPGRADING.md`, `CONTRIBUTING.md`, `SECURITY.md`. */
  readonly file?: string;
  /** A record of changes (`UPGRADING.md`): its sections come after every other hit of a search. */
  readonly changes?: true;
}

/**
 * A part of the navigation and of the start page, its pages in reading order. Previous and next lead through every page of every
 * section in this order. Every `docs/*.md` needs its entry — an unlisted page stops the start, as an unlisted package does.
 */
export interface DocsSection {
  readonly title: string;
  readonly pages: readonly DocsPageEntry[];
}

export interface DocsGroup<N extends string = PackageName> {
  readonly title: string;
  readonly packages: readonly N[];
}

/** The packages no group lists — `never` when every one has its place. */
type Unlisted<G extends readonly DocsGroup[]> = Exclude<PackageName, G[number]['packages'][number]>;

/** Refuses a navigation that leaves a package out: the error names it. */
type EveryPackageListed<G extends readonly DocsGroup[]> = [Unlisted<G>] extends [never]
  ? G
  : { readonly 'every package needs a group — not listed': Unlisted<G> };

export interface DocsDefinition<G extends readonly DocsGroup[] = readonly DocsGroup[]> {
  readonly sections: readonly DocsSection[];
  /** The packages' READMEs — until they become cards on npm, as the navigation's last part ("Package READMEs"). */
  readonly groups: G;
}

export function defineDocs<const G extends readonly DocsGroup[]>(docs: { readonly sections: readonly DocsSection[]; readonly groups: G & EveryPackageListed<G> }): DocsDefinition<G> {
  return docs;
}

export default defineDocs({
  sections: [
    {
      title: 'Prologue',
      pages: [
        { slug: 'upgrading', label: 'Upgrade Guide', file: 'UPGRADING.md', changes: true },
        { slug: 'releases', label: 'Release Policy' },
        { slug: 'contributing', label: 'Contribution Guide', file: 'CONTRIBUTING.md' },
        { slug: 'security-policy', label: 'Security Policy', file: 'SECURITY.md' },
        { slug: 'packages', label: 'Packages' },
      ],
    },
    {
      title: 'Getting Started',
      pages: [
        { slug: 'installation', label: 'Installation' },
        { slug: 'configuration', label: 'Configuration' },
        { slug: 'structure', label: 'Directory Structure' },
        { slug: 'starter-kit', label: 'Starter Kit' },
        { slug: 'deployment', label: 'Deployment' },
      ],
    },
    {
      title: 'Architecture Concepts',
      pages: [
        { slug: 'lifecycle', label: 'Request Lifecycle' },
        { slug: 'modules', label: 'Modules & Discovery' },
        { slug: 'container', label: 'Service Container' },
        { slug: 'providers', label: 'Service Providers' },
        { slug: 'context', label: 'Context' },
      ],
    },
    {
      title: 'The Basics',
      pages: [
        { slug: 'routing', label: 'Routing' },
        { slug: 'middleware', label: 'Middleware' },
        { slug: 'csrf', label: 'CSRF Protection' },
        { slug: 'controllers', label: 'Controllers' },
        { slug: 'requests', label: 'Requests' },
        { slug: 'responses', label: 'Responses' },
        { slug: 'urls', label: 'URL Generation' },
        { slug: 'session', label: 'Session' },
        { slug: 'validation', label: 'Validation' },
        { slug: 'errors', label: 'Error Handling' },
        { slug: 'logging', label: 'Logging' },
      ],
    },
    {
      title: 'Frontend',
      pages: [
        { slug: 'pages', label: 'Pages & Layouts' },
        { slug: 'navigation', label: 'Navigation & View Transitions' },
        { slug: 'forms', label: 'Forms' },
        { slug: 'actions', label: 'Actions' },
        { slug: 'dialogs', label: 'Dialogs & Layers' },
        { slug: 'deferred-props', label: 'Deferred Props & Islands' },
        { slug: 'client-features', label: 'Client Features & Tab Sync' },
        { slug: 'vite', label: 'Asset Bundling (Vite)' },
        { slug: 'styling', label: 'Styling' },
      ],
    },
    {
      title: 'Digging Deeper',
      pages: [
        { slug: 'console', label: 'Console' },
        { slug: 'cache', label: 'Cache' },
        { slug: 'events', label: 'Events' },
        { slug: 'storage', label: 'File Storage' },
        { slug: 'localization', label: 'Localization' },
        { slug: 'mail', label: 'Mail' },
        { slug: 'notifications', label: 'Notifications' },
        { slug: 'queues', label: 'Queues' },
        { slug: 'rate-limiting', label: 'Rate Limiting' },
        { slug: 'realtime', label: 'Real-time Updates' },
        { slug: 'scheduling', label: 'Task Scheduling' },
        { slug: 'tables', label: 'Data Tables' },
        { slug: 'package-development', label: 'Package Development' },
      ],
    },
    {
      title: 'Security',
      pages: [
        { slug: 'security', label: 'Security Overview' },
        { slug: 'authentication', label: 'Authentication' },
        { slug: 'authorization', label: 'Authorization' },
        { slug: 'verification', label: 'Email Verification' },
        { slug: 'passwords', label: 'Password Reset' },
        { slug: 'api-tokens', label: 'API Tokens' },
        { slug: 'encryption', label: 'Encryption' },
        { slug: 'hashing', label: 'Hashing' },
        { slug: 'csp', label: 'Content Security Policy' },
      ],
    },
    {
      title: 'Database',
      pages: [
        { slug: 'database', label: 'Getting Started' },
        { slug: 'queries', label: 'Repositories & Queries' },
        { slug: 'pagination', label: 'Pagination' },
        { slug: 'migrations', label: 'Migrations' },
        { slug: 'seeding', label: 'Seeding & Factories' },
        { slug: 'transactions', label: 'Transactions' },
        { slug: 'redis', label: 'Redis' },
      ],
    },
    {
      title: 'Testing',
      pages: [
        { slug: 'testing', label: 'Getting Started' },
        { slug: 'http-tests', label: 'HTTP Tests' },
        { slug: 'database-testing', label: 'Database Testing' },
        { slug: 'fakes', label: 'Fakes' },
        { slug: 'time', label: 'Time' },
        { slug: 'testing-pages', label: 'Testing Pages' },
      ],
    },
    {
      title: 'Tools',
      pages: [
        { slug: 'devtools', label: 'Devtools' },
        { slug: 'observability', label: 'Observability' },
        { slug: 'health', label: 'Health Checks' },
      ],
    },
  ],
  groups: [
    { title: 'Core', packages: ['core', 'cli', 'create-marmeon', 'log', 'encryption', 'testing'] },
    { title: 'HTTP', packages: ['router', 'http', 'server', 'session', 'vite', 'i18n', 'validation'] },
    { title: 'Data', packages: ['database', 'cache', 'redis', 'table'] },
    { title: 'Auth & Mail', packages: ['auth', 'mail', 'notifications'] },
    { title: 'Background', packages: ['queue', 'scheduler', 'storage', 'live'] },
    { title: 'Frontend', packages: ['react'] },
    { title: 'Tools', packages: ['devtools', 'otel'] },
  ],
});
