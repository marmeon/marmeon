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
  'create-bespoke-app',
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
  'testing',
  'vite',
] as const;

export type PackageName = (typeof PACKAGES)[number];

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
  readonly groups: G;
}

export function defineDocs<const G extends readonly DocsGroup[]>(docs: { readonly groups: G & EveryPackageListed<G> }): DocsDefinition<G> {
  return docs;
}

export default defineDocs({
  groups: [
    { title: 'Core', packages: ['core', 'cli', 'create-bespoke-app', 'log', 'encryption', 'testing'] },
    { title: 'HTTP', packages: ['router', 'http', 'server', 'session', 'vite', 'i18n'] },
    { title: 'Data', packages: ['database', 'cache', 'redis'] },
    { title: 'Auth & Mail', packages: ['auth', 'mail', 'notifications'] },
    { title: 'Background', packages: ['queue', 'scheduler', 'storage', 'live'] },
    { title: 'Frontend', packages: ['react'] },
    { title: 'Tools', packages: ['devtools', 'otel'] },
  ],
});
