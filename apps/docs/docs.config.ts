/**
 * The navigation of the docs: every framework package (a directory under `packages/` with a README.md) in exactly one group.
 * Typed against `PACKAGES` — a name that is no package, or a package in no group, is a compile error — and checked against the
 * repository when the app boots: a package without an entry here, or an entry without its README, stops the start.
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

/**
 * A guide: a Markdown file of the repository that is no package's README — `docs/*.md` (every one needs its entry: an unlisted
 * guide stops the start, as an unlisted package does) and the policies at the root (`UPGRADING.md`, …), which stay where GitHub
 * and the release tooling look for them. Served at `/guides/<slug>`, in this order, as the navigation's first group.
 */
export interface DocsGuide {
  readonly slug: string;
  /** The file, relative to the repository: `docs/deployment.md`, `UPGRADING.md`. */
  readonly file: string;
  /** Its name in the navigation (the page's title is its `#` heading). */
  readonly label: string;
  /** A record of changes (`UPGRADING.md`): its sections come after every other hit of a search — the pages explain the API. */
  readonly changes?: true;
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
  readonly guides?: readonly DocsGuide[];
  readonly groups: G;
}

export function defineDocs<const G extends readonly DocsGroup[]>(docs: { readonly guides?: readonly DocsGuide[]; readonly groups: G & EveryPackageListed<G> }): DocsDefinition<G> {
  return docs;
}

/** The group of the guides in the navigation — before the packages'. */
export const GUIDES_GROUP = 'Guides';

export default defineDocs({
  guides: [
    { slug: 'getting-started', file: 'docs/getting-started.md', label: 'Getting started' },
    { slug: 'lists', file: 'docs/lists.md', label: 'Lists and pagination' },
    { slug: 'tables', file: 'docs/tables.md', label: 'Tables' },
    { slug: 'navigation', file: 'docs/navigation.md', label: 'Navigation and view transitions' },
    { slug: 'realtime', file: 'docs/realtime.md', label: 'Real time' },
    { slug: 'deployment', file: 'docs/deployment.md', label: 'Deployment' },
    { slug: 'security', file: 'docs/security.md', label: 'Security' },
    { slug: 'versioning', file: 'docs/versioning.md', label: 'Versions and deprecations' },
    { slug: 'upgrading', file: 'UPGRADING.md', label: 'Upgrading', changes: true },
    { slug: 'contributing', file: 'CONTRIBUTING.md', label: 'Contributing' },
    { slug: 'security-policy', file: 'SECURITY.md', label: 'Reporting a vulnerability' },
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
