import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appBundle,
  appClientBuild,
  appEntry,
  BUDGET_WHERE,
  budgetProblem,
  kb,
  loweredLimit,
  lowerLimits,
  PACKAGES,
  readBudget,
  SCENARIOS,
  tableEntry,
  type AppBundle,
  type Scenario,
} from './__fixtures__/bundle.ts';

/**
 * What a browser downloads for the client core and the React adapter: sizes held by a ratchet and a
 * leak test per feature. Built as an app builds them (Vite app mode, production, minified) against the packages'
 * `dist/` — run `pnpm build` first. React and i18n are not counted.
 *
 * `packages/react/size-budget.json` holds the limits and the features that still leak; both only shrink. For the
 * attribution of every byte to its module, and the real apps, run `pnpm size`.
 */

const budget = readBudget();
type LeakScenario = 'core' | 'emptyApp' | 'minimalApp';

/**
 * What each scenario uses on purpose: `useForm` remembers a form's input and guards it while dirty (`remember`, `guard`:
 * static in it — a guard loaded later could not stop a navigation that came first; only `validate` loads on first use).
 */
const USES: Record<Scenario, readonly string[]> = {
  core: [],
  emptyApp: [],
  minimalApp: ['guard', 'remember'],
  everything: [],
  // The headless table: sorting and filters are query state; its actions (the actions feature, the page's reloads) are
  // a chunk loaded with the first run.
  table: ['table', 'queryState'],
};

/** A feature's entry: the scenario it adds to, plus its import. */
const inApp = (...names: string[]) => ({ base: 'emptyApp' as const, entry: appEntry(...names) });

/**
 * The optional features and how to recognise them in a bundle: by module (`<package>/<path>` without src/dist and
 * extension) — the navigator's part of each lives in `http/client/features/`, and the hook or component that uses one
 * attaches it. `use` is the import an app uses it through, on top of a scenario; `brings`, the features it builds on.
 */
const FEATURES = {
  // The core loads them when the server answers with a layer, <Link layer> where it renders: the core's layers and
  // the React layer stack in chunks of their own. `react/layer` (useLayer) and `react/layer-dialog` (the default frame) are no
  // markers: views and an app's frame import them, small and static.
  layers: { markers: ['http/client/features/layers', 'http/client/layer', 'react/layer-stack'], use: inApp('Link'), lazy: true },
  islands: { markers: ['http/client/features/islands', 'http/client/region', 'react/island'], use: inApp('Island'), brings: ['poll'] }, // <Island poll>
  actions: { markers: ['http/client/features/actions', 'http/client/action', 'react/use-action'], use: inApp('useAction') },
  // The page's patches: with `useRouter()` (`router.optimistic`/`reloading`), loaded with the first use, in a chunk of
  // its own. `optimistic.ts` (the patch queue) is no marker: layers and islands keep their own patches with it; the core applies a
  // visit's (`patches.ts`).
  optimistic: { markers: ['http/client/features/optimistic'], use: inApp('useRouter'), lazy: true },
  // useForm(…, { validate }): on a form's first use, in a chunk of its own. useForm remembers (static).
  liveValidation: { markers: ['http/client/live-validation', 'http/client/features/live-validation'], use: inApp('useForm'), brings: ['guard', 'remember'], lazy: true },
  queryState: { markers: ['http/client/features/query-state', 'react/use-query-state'], use: inApp('useQueryState') },
  remember: { markers: ['http/client/remember', 'http/client/features/remember', 'react/remember'], use: inApp('useRemember') },
  poll: { markers: ['http/client/poll', 'react/use-poll', 'react/when-visible'], use: inApp('usePoll') },
  // The progress bar: opt-in, `createMarmeonApp({ progress: progressBar() })` — `aria-busy` (`http/client/busy`) is every app's.
  progress: { markers: ['http/client/progress'], use: inApp('progressBar') },
  // <Link prefetch>, router.prefetch: on the first prefetch, in a chunk of its own.
  prefetch: { markers: ['http/client/features/prefetch'], use: inApp('Link'), lazy: true },
  // Any view of resolveModulePages may declare it: the resolver brings it, <MarmeonApp> attaches it.
  revalidateOnBack: { markers: ['http/client/features/revalidate-on-back'], use: inApp('resolveModulePages') },
  // useBlocker, useForm({ guard }), <Form guard>: static (a guard loaded later could not stop what came first). Asking — a
  // visit's, an action's `confirm`, the guard's question — is the core's (`http/client/confirm`).
  guard: { markers: ['http/client/features/guard'], use: inApp('useBlocker') },
  // <Link instant>: loaded where one renders, in a chunk of its own.
  instant: { markers: ['http/client/features/instant'], use: inApp('Link'), lazy: true },
  form: { markers: ['react/form'], use: inApp('Form'), brings: ['guard', 'remember'] }, // <Form remember guard>, static like useForm's
  pagination: { markers: ['react/pagination'], use: inApp('Pagination') },
  // Uploads: <FileInput> (static, small) loads the feature where it renders, in a chunk of its own with the XHR code —
  // which the core also loads with the first FormData visit with progress. Running uploads and tokens: its slot only.
  uploads: { markers: ['http/client/upload', 'http/client/features/uploads'], use: inApp('FileInput'), lazy: true },
  // Server-driven like the layers — the core loads it when an answer follows a channel (`PageObject.live`); an app that
  // asks for the waiting updates (`useLiveUpdates`) loads it too. The stream, sequences and hints: its document slot only.
  live: { markers: ['http/client/features/live'], use: inApp('useLiveUpdates'), lazy: true },
  // The client hook API: a feature, not the core — an app that listens (`navigator.use(hooks)`) carries it.
  hooks: { markers: ['http/client/features/hooks'], use: { base: 'emptyApp' as const, entry: `${appEntry()}import { hooks } from '@marmeon/http/client';\nglobalThis.__hooks = hooks;\n` } },
  // Tab sync: a default feature of `createMarmeonApp` — loaded with the first page, before hydrating, in a chunk of
  // its own; `createMarmeonApp({ tabSync: false })` never loads it. The core alone carries none of it.
  tabSync: { markers: ['http/client/features/tab-sync', 'http/tab-sync-protocol'], use: inApp(), lazy: true },
  // The History fallback: `createMarmeonApp` loads it beside the first page only where the browser has no Navigation
  // API — a chunk of its own, never in a first download. The core alone carries none of it (an adapter loads it).
  history: { markers: ['http/client/features/history-fallback'], use: inApp(), lazy: true },
  // View transitions: the core loads them before the first page change that asks for one (a visit's, a link's, the
  // app's `viewTransition`) — a chunk of its own, never in a first download; only the loader is.
  viewTransitions: { markers: ['http/client/features/view-transitions'], use: inApp(), lazy: true },
  // What a failure shows: the dialogs of a failed visit and the error page for a page that threw — a chunk
  // <MarmeonApp> loads when it happens, never in a first download (the error boundary stays). `react/error-page` is no marker: the
  // adapter's main entry exports `ErrorPage` (everything holds it); the built-in page itself is checked on its own below.
  failures: { markers: ['react/failure'], use: inApp(), lazy: true },
  // The headless table: `@marmeon/react/table` and what it builds on — the core's row selection (a slot of the
  // entry) and the table's UI-free controller. Only with its own import: never in an app without tables (its subpath, an optional peer).
  table: { markers: ['http/client/features/selection', 'table/client/table', 'react/table'], use: { base: 'emptyApp' as const, entry: tableEntry() }, brings: ['queryState'] },
  // The TanStack Table bridge (`@marmeon/react/table-tanstack`, TanStack v9 an optional peer): TanStack only where the app imports it.
  tanstack: {
    markers: ['react/table-tanstack', 'node_modules/@tanstack/'],
    use: {
      base: 'emptyApp' as const,
      entry: tableEntry(
        "import { toTanStack } from '@marmeon/react/table-tanstack';\n",
        "import { useTable as useTanStackTable, tableFeatures } from '@tanstack/react-table';\n",
        'globalThis.__tanstack = { toTanStack, useTanStackTable, tableFeatures };\n',
      ),
    },
    brings: ['table', 'queryState'],
  },
} satisfies Record<string, { markers: readonly (string | RegExp)[]; use: { base: LeakScenario; entry: string }; brings?: readonly string[]; lazy?: true }>;
type Feature = keyof typeof FEATURES;
const FEATURE_NAMES = Object.keys(FEATURES) as Feature[];

/** The features no app carries unless it uses them. */
const EXTRACTED: readonly Feature[] = ['queryState', 'liveValidation', 'remember', 'actions', 'prefetch', 'revalidateOnBack', 'instant', 'guard', 'islands', 'layers', 'optimistic', 'uploads', 'progress', 'live', 'hooks', 'table', 'tanstack', 'viewTransitions', 'failures'];

/** `http/dist/client/layer.js` → `http/client/layer`. */
const moduleKey = (id: string) => id.replace(/^([^/]+)\/(?:src|dist)\//, '$1/').replace(/\.[cm]?[jt]sx?$/, '');

const sorted = (features: Iterable<string>) => [...new Set(features)].sort();

/** The features a bundle holds, sorted — in its first download, or (`lazy`) in the chunks it loads on demand. */
function featuresIn({ modules, lazyModules, code }: AppBundle, lazy = false): string[] {
  const keys = new Set((lazy ? lazyModules : modules).map(moduleKey));
  if (lazy) code = '';
  const markers: Record<string, readonly (string | RegExp)[]> = Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, FEATURES[feature].markers]));
  // A marker ending in "/" is a directory — a third-party package (`node_modules/@tanstack/`): any module of it.
  const has = (marker: string) => (marker.endsWith('/') ? [...keys].some((key) => key.startsWith(marker)) : keys.has(marker));
  return sorted(FEATURE_NAMES.filter((feature) => markers[feature]!.some((marker) => (typeof marker === 'string' ? has(marker) : marker.test(code)))));
}

/**
 * The leak test's `devtools` marker: a module of @marmeon/devtools or the bar's data feature of the
 * client core (`http/client/features/devtools`), or the devtools' paths, markup and dev hook in the code (`/_marmeon/devtools`,
 * `@marmeon/devtools`, `data-marmeon-devtools`, `__MARMEON_DEVTOOLS_HOOK__` — the core calls it only under
 * `process.env.NODE_ENV !== 'production'`). Not the bare word — react-dom's production build names `__REACT_DEVTOOLS_GLOBAL_HOOK__`.
 */
const DEVTOOLS_MARKERS = /_marmeon\/devtools|@marmeon\/devtools|data-marmeon-devtools|__MARMEON_DEVTOOLS_HOOK__/;

function devtoolsIn({ modules, lazyModules, code, lazyCode }: AppBundle): string[] {
  const found = [...modules, ...lazyModules].filter((id) => id.startsWith('devtools/') || moduleKey(id) === 'http/client/features/devtools');
  const text = DEVTOOLS_MARKERS.exec(`${code}\n${lazyCode}`)?.[0];
  return text ? [...found, text] : found;
}

const bundles = new Map<string, AppBundle>();
const lowered: Partial<Record<Scenario, number>> = {};
const update = process.env.MARMEON_SIZE_BUDGET === 'update';

beforeAll(async () => {
  const entries: [string, string][] = [
    ...Object.entries(SCENARIOS),
    ...FEATURE_NAMES.map((feature): [string, string] => [`feature:${feature}`, FEATURES[feature].use.entry]),
  ];
  // Rolldown builds these in a few hundred milliseconds — together.
  await Promise.all(entries.map(async ([name, entry]) => bundles.set(name, await appBundle(entry))));
}, 60_000);

afterAll(() => {
  if (update && Object.keys(lowered).length > 0) lowerLimits(lowered);
});

const bundle = (name: string): AppBundle => {
  const found = bundles.get(name);
  if (!found) throw new Error(`No bundle "${name}" — did the build fail?`);
  return found;
};

describe('the client bundle stays within its budget (a ratchet)', () => {
  it.each(Object.keys(SCENARIOS) as Scenario[])('%s', (name) => {
    const line = budget.gzipKB[name];
    expect(line, `${BUDGET_WHERE} has no limit for "${name}"`).toBeDefined();
    const size = kb(bundle(name).gzip);
    // update: a saving lowers the limit to the size + the reserve; a size over its limit stays red — never raised.
    const lower = update ? loweredLimit(size, line) : undefined;
    if (lower !== undefined) lowered[name] = lower;
    const problem = budgetProblem(name, size, lower === undefined ? line : { ...line, limit: lower });
    // The whole message as the assertion's (Vitest shortens the value it prints).
    expect(problem, problem).toBeUndefined();
  });

  it('the budget file only names scenarios this test builds', () => {
    expect(Object.keys(budget.gzipKB).sort()).toEqual(Object.keys(SCENARIOS).sort());
    expect(Object.keys(budget.stillLeaking).sort()).toEqual(['core', 'emptyApp', 'minimalApp']);
  });
});

describe('an app holds only the features it uses (leak test)', () => {
  // `stillLeaking` lists what is in there without being used. A new leak fails, and so does a listed one that is gone —
  // then take it off the list.
  it.each(['core', 'emptyApp', 'minimalApp'] as const)('%s', (name) => {
    const leaking = featuresIn(bundle(name)).filter((feature) => !USES[name].includes(feature));
    expect(leaking, `Features in "${name}" it does not use — update stillLeaking.${name} in ${BUDGET_WHERE} only when one is gone`).toEqual(
      sorted(budget.stillLeaking[name]),
    );
  });

  // In none of these unless it is used — whatever stillLeaking says (a feature may not come back onto that list).
  it.each(EXTRACTED)('%s is in no scenario that does not use it', (feature) => {
    for (const name of ['core', 'emptyApp', 'minimalApp'] as const) {
      if (USES[name].includes(feature)) continue;
      expect(featuresIn(bundle(name)), `${feature} in "${name}"`).not.toContain(feature);
    }
  });

  // Whatever an app imports, the layers are a chunk the core loads when the server answers with one — never in the first
  // download, and always there to load (a layer may answer any visit).
  it.each(['core', 'emptyApp', 'minimalApp', 'everything'] as const)('the layers are a chunk of their own in %s — loaded on demand', (name) => {
    const built = bundle(name);
    expect(featuresIn(built)).not.toContain('layers');
    expect(featuresIn(built, true)).toContain('layers');
  });

  // The XHR code is no part of any first download — the core loads it with the first FormData visit with progress.
  it('the core alone carries uploads only in a chunk it loads on demand', () => {
    expect(featuresIn(bundle('core'))).not.toContain('uploads');
    expect(featuresIn(bundle('core'), true)).toContain('uploads');
  });

  // An answer may follow a live channel whatever the app imported — the core loads the feature then (server-driven, like the
  // layers): never in a first download, always there to load.
  it.each(['core', 'emptyApp', 'minimalApp', 'everything'] as const)('live props are a chunk of their own in %s — loaded on demand', (name) => {
    const built = bundle(name);
    expect(featuresIn(built)).not.toContain('live');
    expect(featuresIn(built, true)).toContain('live');
  });

  // Every app of createMarmeonApp loads tab sync — in a chunk of its own, never in a first download; the core alone
  // carries none of it, not even lazily.
  it.each(['emptyApp', 'minimalApp', 'everything'] as const)('tab sync is a chunk of its own in %s — loaded by createMarmeonApp', (name) => {
    const built = bundle(name);
    expect(featuresIn(built)).not.toContain('tabSync');
    expect(featuresIn(built, true)).toContain('tabSync');
  });

  // The History fallback only where the browser has no Navigation API — a chunk createMarmeonApp loads then.
  it.each(['emptyApp', 'minimalApp', 'everything', 'table'] as const)('the History fallback is a chunk of its own in %s — never in the first download', (name) => {
    const built = bundle(name);
    expect(featuresIn(built)).not.toContain('history');
    expect(featuresIn(built, true)).toContain('history');
  });

  // Whatever an app imports, view transitions are a chunk the core loads with the first visit that asks for one.
  it.each(['core', 'emptyApp', 'minimalApp', 'everything', 'table'] as const)('view transitions are a chunk of their own in %s — never in the first download', (name) => {
    const built = bundle(name);
    expect(featuresIn(built), 'view transitions in the first download').not.toContain('viewTransitions');
    expect(featuresIn(built, true)).toContain('viewTransitions');
  });

  // What a failure shows — the failure dialogs, the error page for a page that threw, the built-in error page — is
  // a chunk of its own in every app of <MarmeonApp>; its styles are classes of styles.css, so none of it is in the first download.
  it.each(['emptyApp', 'minimalApp', 'everything', 'table'] as const)('the failure dialogs are a chunk of their own in %s — never in the first download', (name) => {
    const built = bundle(name);
    expect(featuresIn(built), 'the failure dialogs in the first download').not.toContain('failures');
    expect(featuresIn(built, true)).toContain('failures');
    // The notice of an unreachable server stays in the first download: offline, no chunk loads.
    expect(built.code, 'the notice of an unreachable server').toContain('The server could not be reached.');
    // The built-in error page too — but for everything, which keeps the adapter's export of `ErrorPage`.
    if (name !== 'everything') {
      expect(built.modules, 'the built-in error page in the first download').not.toContain('react/dist/error-page.js');
      expect(built.lazyModules).toContain('react/dist/error-page.js');
    }
  });

  it('the core alone carries no History fallback — not in its first download, not in a chunk (the adapter loads it)', () => {
    expect([...featuresIn(bundle('core')), ...featuresIn(bundle('core'), true)]).not.toContain('history');
  });

  // useRouter() loads the page's optimistic patches with the first router.optimistic()/reloading() — every app with a router
  // (the docs app's header search) carries only the loader.
  it('the page’s optimistic patches are a chunk of their own in everything — loaded with the first router.optimistic()', () => {
    expect(featuresIn(bundle('everything'))).not.toContain('optimistic');
    expect(featuresIn(bundle('everything'), true)).toContain('optimistic');
  });

  it('the core alone carries no tab sync — not in its first download, not in a chunk', () => {
    expect(featuresIn(bundle('core'))).not.toContain('tabSync');
    expect(featuresIn(bundle('core'), true)).not.toContain('tabSync');
  });

  // The headless table and the TanStack bridge come with their own imports only — in no other scenario, not
  // even in `everything` (all of the adapter's main entry: their subpaths have optional peers), and TanStack not with `useTable` alone.
  it.each(['core', 'emptyApp', 'minimalApp', 'everything'] as const)('the headless table and TanStack are in no bundle of %s — first download or lazy', (name) => {
    const built = bundle(name);
    expect([...featuresIn(built), ...featuresIn(built, true)].filter((feature) => feature === 'table' || feature === 'tanstack')).toEqual([]);
  });

  it('the bridge’s scenario carries TanStack itself — the marker sees its modules, not only the bridge', () => {
    expect(bundle('feature:tanstack').modules.filter((id) => id.startsWith('node_modules/@tanstack/')).length).toBeGreaterThan(0);
  });

  it('the table scenario carries the headless table, but no TanStack — only the bridge’s import brings it', () => {
    expect([...featuresIn(bundle('table')), ...featuresIn(bundle('table'), true)], 'TanStack without the bridge’s import').not.toContain('tanstack');
    expect(featuresIn(bundle('table'))).toEqual(sorted(USES.table));
    // Its actions: the actions feature and the page's reloads load with the first run, in a chunk of their own.
    expect(featuresIn(bundle('table'), true)).toEqual(expect.arrayContaining(['actions', 'optimistic']));
    expect(bundle('table').lazyModules).toContain('table/dist/client/run.js');
    expect(bundle('table').modules.filter((id) => id.startsWith('node_modules/@tanstack/'))).toEqual([]);
  });

  it('a view that asks useLayer() and an app frame of LayerDialog bring no layer code into the first download', async () => {
    const built = await appBundle(appEntry('useLayer', 'LayerDialog'));
    expect(featuresIn(built)).toEqual(sorted(USES.emptyApp));
    expect(built.modules).toEqual(expect.arrayContaining(['react/dist/layer.js', 'react/dist/layer-dialog.js']));
  });

  it('the web app opens its layers from a chunk of their own: the core’s layers and the React layer stack — and carries no devtools', async () => {
    const node = process.env.NODE_ENV;
    try {
      const built = await appClientBuild(join(PACKAGES, '../apps/web-app'));
      expect(featuresIn(built)).not.toContain('layers');
      expect(built.lazyModules).toEqual(expect.arrayContaining(['http/dist/client/features/layers.js', 'http/dist/client/layer.js', 'react/dist/layer-stack.js']));
      // The devtools — pages, link, recorder — are never in a client chunk, first download or lazy.
      expect(devtoolsIn(built), 'web-app').toEqual([]);
      // The members table (useTable) comes with its page — a lazy chunk; TanStack is in no chunk (the app has no bridge).
      expect(featuresIn(built)).not.toContain('table');
      expect(featuresIn(built, true)).toContain('table');
      expect([...featuresIn(built), ...featuresIn(built, true)]).not.toContain('tanstack');
      // Validation is the server's — the lab's form imports types of its rules only; no rule, no Valibot in any chunk.
      const leaked = [...built.modules, ...built.lazyModules].filter((id) => id.startsWith('validation/') || id.includes('valibot'));
      expect(leaked, `web-app client chunks with validation code: ${leaked.join(', ')}`).toEqual([]);
    } finally {
      process.env.NODE_ENV = node;
    }
  }, 60_000);

  it('the docs app carries no devtools either — it has them as a dev dependency and uses them under marmeon dev', async () => {
    const node = process.env.NODE_ENV;
    try {
      expect(devtoolsIn(await appClientBuild(join(PACKAGES, '../apps/website'))), 'website').toEqual([]);
    } finally {
      process.env.NODE_ENV = node;
    }
  }, 60_000);

  it('no scenario carries devtools code (development only, never in a build)', () => {
    for (const [name, built] of bundles) expect(devtoolsIn(built), name).toEqual([]);
  });

  it.each(FEATURE_NAMES)('%s comes with its own import — and recognisably so', (feature) => {
    const { use, brings = [], lazy = false }: { use: { base: LeakScenario }; brings?: readonly string[]; lazy?: boolean } = FEATURES[feature];
    const built = bundle(`feature:${feature}`);
    // A feature loaded on first use comes with its component, but in a chunk of its own — not in the first download.
    expect(featuresIn(built)).toEqual(sorted([...USES[use.base], ...budget.stillLeaking[use.base], ...(lazy ? [] : [feature]), ...brings]));
    if (lazy) expect(featuresIn(built, true)).toContain(feature);
  });
});

describe('no injection metadata in the browser', () => {
  it('no bundle carries an injection list or reason', () => {
    for (const [name, { code }] of bundles) {
      expect(code.match(/marmeon\.injection[^"'`]*|static inject\b|Cannot inject[^"'`]{0,60}/)?.[0], name).toBeUndefined();
    }
  });

  it('the browser lists in package.json cover every module a browser entry bundles', async () => {
    const entries = [
      `import * as client from '@marmeon/http/client';\nimport * as page from '@marmeon/http/page';\nglobalThis.__keep = { client, page };\n`,
      `import * as react from '@marmeon/react';\nimport * as messages from '@marmeon/i18n/messages';\nglobalThis.__keep = { react, messages };\n`,
    ];
    const modules = (await Promise.all(entries.map((entry) => appBundle(entry, { external: /^react(-dom)?(\/|$)/ })))).flatMap((built) => built.modules);
    const uncovered = modules.filter((id) => {
      const [name, ...rest] = id.split('/');
      if (id === '(entry)' || name === 'router') return false; // @marmeon/router/url: no classes, no injection
      // dist/x.js → src/x.ts(x): what package.json's globs name
      const source = ['.ts', '.tsx'].map((ext) => rest.join('/').replace(/^dist\//, 'src/').replace(/\.js$/, ext)).find((file) => existsSync(join(PACKAGES, name!, file)));
      const globs: string[] = JSON.parse(readFileSync(join(PACKAGES, name!, 'package.json'), 'utf8')).marmeon?.browser ?? [];
      return !source || !globs.some((glob) => matchesGlob(source, glob));
    });
    expect(uncovered, 'Browser modules outside their package\'s "marmeon": { "browser": [...] } — add them there').toEqual([]);
  }, 60_000);
});

describe('a production bundle says codes, not explanations', () => {
  // A few of the explanations the development build throws or warns: none may ship. A production error is its code
  // and a name (`[marmeon:R2] users/Show`); docs/errors.md ("Error codes") says what each code means.
  const EXPLANATIONS = [
    'the browser has no route manifest',
    'is not defined in the browser',
    'has an invalid layout',
    'must be used inside <MarmeonApp>',
    'needs the app\'s messages',
    'Hydration mismatch',
    'has no heading (h1–h3)',
    'islands cannot change the document head',
    'needs an interval above 0 ms',
    'is for the view of an island',
    'there is no navigator while rendering on the server',
    'does not sort by',
    'offers no row action',
    'it changes something only in the browser',
  ];

  it.each(['core', 'emptyApp', 'minimalApp', 'everything', 'table'] as const)('%s', (name) => {
    const { code, lazyCode } = bundle(name);
    expect(EXPLANATIONS.filter((text) => `${code}\n${lazyCode}`.includes(text))).toEqual([]);
  });

  it('the full bundle throws the codes instead', () => {
    const codes = new Set(bundle('everything').code.match(/\[marmeon:[CR]\d+\]/g));
    for (const code of ['C1', 'C2', 'R1', 'R2', 'R9', 'R10', 'R12']) expect(codes, code).toContain(`[marmeon:${code}]`);
  });

  it('every code is in the docs once (docs/errors.md), and every code there is thrown', () => {
    const sources = (dir: string) =>
      readdirSync(join(PACKAGES, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$|__fixtures__|test-window/.test(file))
        .map((file) => readFileSync(join(PACKAGES, dir, file), 'utf8'));
    const used = sorted([...sources('http/src/client'), ...sources('react/src'), ...sources('table/src/client')].flatMap((text) => [...text.matchAll(/\[marmeon:([CR]\d+)\]/g)].map((match) => match[1]!)));
    const rows = [...readFileSync(join(PACKAGES, '../docs/errors.md'), 'utf8').matchAll(/^\| ([CR]\d+) \|/gm)].map((match) => match[1]!);
    expect(rows.length, 'a code listed twice in docs/errors.md').toBe(new Set(rows).size);
    expect(sorted(rows)).toEqual(used);
  });
});
