/**
 * The navigation of the docs: the sections with their pages (`/docs/<slug>`), in reading order. Checked against the repository
 * when the app boots: a `docs/*.md` without its entry here, or an entry without its file, stops the start. The packages' READMEs
 * are no pages — they are cards for npm that link here.
 */

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
 * section in this order. Every `docs/*.md` needs its entry — an unlisted page stops the start.
 */
export interface DocsSection {
  readonly title: string;
  readonly pages: readonly DocsPageEntry[];
}

export interface DocsDefinition {
  readonly sections: readonly DocsSection[];
}

export function defineDocs(docs: DocsDefinition): DocsDefinition {
  return docs;
}

export default defineDocs({
  sections: [
    {
      title: 'Prologue',
      pages: [
        { slug: 'why-marmeon', label: 'Why Marmeon' },
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
        { slug: 'first-app', label: 'Your First App' },
        { slug: 'deployment', label: 'Deployment' },
      ],
    },
    {
      title: 'Recipes',
      pages: [{ slug: 'recipe-resource', label: 'A Resource With Its Policy' }],
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
        { slug: 'drivers', label: 'Drivers' },
        { slug: 'package-development', label: 'Package Development' },
      ],
    },
    {
      title: 'Security',
      pages: [
        { slug: 'security', label: 'Security Overview' },
        { slug: 'authentication', label: 'Authentication' },
        { slug: 'two-factor-authentication', label: 'Two-Factor Authentication' },
        { slug: 'passkeys', label: 'Passkeys' },
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
        { slug: 'check', label: 'Checking an App' },
      ],
    },
    {
      title: 'Tools',
      pages: [
        { slug: 'devtools', label: 'Devtools' },
        { slug: 'observability', label: 'Observability' },
        { slug: 'health', label: 'Health Checks' },
        { slug: 'agents', label: 'Coding Agents' },
      ],
    },
  ],
});
