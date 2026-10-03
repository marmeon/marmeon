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
  limitFor,
  lowerLimits,
  PACKAGES,
  readBudget,
  SCENARIOS,
  type AppBundle,
  type Scenario,
} from './__fixtures__/bundle.ts';

/**
 * What a browser downloads for the client core and the React adapter (Wave 5c, E75): sizes held by a ratchet and a
 * leak test per feature. Built as an app builds them (Vite app mode, production, minified) against the packages'
 * `dist/` — run `pnpm build` first. React and i18n are not counted.
 *
 * `packages/react/size-budget.json` holds the limits and the features that still leak; both only shrink. For the
 * attribution of every byte to its module, and the real apps, run `pnpm size`.
 */

const budget = readBudget();
type LeakScenario = Exclude<Scenario, 'everything'>;

/**
 * What each scenario uses on purpose: `useForm` remembers a form's input and guards it while dirty (`remember`, `guard`:
 * static in it — a guard loaded later could not stop a navigation that came first; E74 loads only `validate` on first use).
 */
const USES: Record<Scenario, readonly string[]> = { core: [], emptyApp: [], minimalApp: ['guard', 'remember'], everything: [] };

/** A feature's entry: the scenario it adds to, plus its import. */
const inApp = (...names: string[]) => ({ base: 'emptyApp' as const, entry: appEntry(...names) });

/**
 * The optional features and how to recognise them in a bundle: by module (`<package>/<path>` without src/dist and
 * extension) — the navigator's part of each lives in `http/client/features/` since Wave 5c step 2. Step 4 takes them out
 * of the default registration one by one (those still in it are `stillLeaking`): then the hook or component that uses one
 * attaches it. `use` is the import an app uses it through, on top of a scenario; `brings`, the features it builds on.
 */
const FEATURES = {
  // The core loads them when the server answers with a layer (E71), <Link layer> where it renders (E74): the core's layers and
  // the React layer stack in chunks of their own. `react/layer` (useLayer) and `react/layer-dialog` (the default frame) are no
  // markers: views and an app's frame import them, small and static.
  layers: { markers: ['http/client/features/layers', 'http/client/layer', 'react/layer-stack'], use: inApp('Link'), lazy: true },
  islands: { markers: ['http/client/features/islands', 'http/client/region', 'react/island'], use: inApp('Island'), brings: ['poll'] }, // <Island poll>
  actions: { markers: ['http/client/features/actions', 'http/client/action', 'react/use-action'], use: inApp('useAction') },
  // The page's patches (E59): with `useRouter()` (`router.optimistic`/`reloading`), attached on first use (W5c.6). `optimistic.ts`
  // (the patch queue) is no marker: layers and islands keep their own patches with it; the core applies a visit's (`patches.ts`).
  optimistic: { markers: ['http/client/features/optimistic'], use: inApp('useRouter') },
  // useForm(…, { validate }): on a form's first use (E74), in a chunk of its own. useForm remembers (static).
  liveValidation: { markers: ['http/client/live-validation', 'http/client/features/live-validation'], use: inApp('useForm'), brings: ['guard', 'remember'], lazy: true },
  queryState: { markers: ['http/client/features/query-state', 'react/use-query-state'], use: inApp('useQueryState') },
  remember: { markers: ['http/client/remember', 'http/client/features/remember', 'react/remember'], use: inApp('useRemember') },
  poll: { markers: ['http/client/poll', 'react/use-poll', 'react/when-visible'], use: inApp('usePoll') },
  // The progress bar (E82): opt-in, `createBespokeApp({ progress: progressBar() })` — `aria-busy` (`http/client/busy`) is every app's.
  progress: { markers: ['http/client/progress'], use: inApp('progressBar') },
  // <Link prefetch>, router.prefetch: on the first prefetch (E74), in a chunk of its own.
  prefetch: { markers: ['http/client/features/prefetch'], use: inApp('Link'), lazy: true },
  // Any view of resolveModulePages may declare it (E58): the resolver brings it, <BespokeApp> attaches it.
  revalidateOnBack: { markers: ['http/client/features/revalidate-on-back'], use: inApp('resolveModulePages') },
  // useBlocker, useForm({ guard }), <Form guard>: static (a guard loaded later could not stop what came first). Asking — a
  // visit's, an action's `confirm`, the guard's question — is the core's (`http/client/confirm`).
  guard: { markers: ['http/client/features/guard'], use: inApp('useBlocker') },
  // <Link instant>: loaded where one renders (E74), in a chunk of its own.
  instant: { markers: ['http/client/features/instant'], use: inApp('Link'), lazy: true },
  form: { markers: ['react/form'], use: inApp('Form'), brings: ['guard', 'remember'] }, // <Form remember guard>, static like useForm's
  pagination: { markers: ['react/pagination'], use: inApp('Pagination') },
  // Uploads (W6.9): <FileInput> (static, small) loads the feature where it renders, in a chunk of its own with the XHR code —
  // which the core also loads with the first FormData visit with progress (W5c.6). Running uploads and tokens: its slot only.
  uploads: { markers: ['http/client/upload', 'http/client/features/uploads'], use: inApp('FileInput'), lazy: true },
  // W6.10: server-driven like the layers — the core loads it when an answer follows a channel (`PageObject.live`); an app that
  // asks for the waiting updates (`useLiveUpdates`) loads it too. The stream, sequences and hints: its document slot only.
  live: { markers: ['http/client/features/live'], use: inApp('useLiveUpdates'), lazy: true },
} satisfies Record<string, { markers: readonly (string | RegExp)[]; use: { base: LeakScenario; entry: string }; brings?: readonly string[]; lazy?: true }>;
type Feature = keyof typeof FEATURES;
const FEATURE_NAMES = Object.keys(FEATURES) as Feature[];

/** The features Wave 5c took out of every app that does not use them (step 4: one commit each; step 5: the layers; step 6: the page's optimistic patches, uploads, the progress bar). */
const EXTRACTED: readonly Feature[] = ['queryState', 'liveValidation', 'remember', 'actions', 'prefetch', 'revalidateOnBack', 'instant', 'guard', 'islands', 'layers', 'optimistic', 'uploads', 'progress', 'live'];

/** `http/dist/client/layer.js` → `http/client/layer`. */
const moduleKey = (id: string) => id.replace(/^([^/]+)\/(?:src|dist)\//, '$1/').replace(/\.[cm]?[jt]sx?$/, '');

const sorted = (features: Iterable<string>) => [...new Set(features)].sort();

/** The features a bundle holds, sorted — in its first download, or (`lazy`) in the chunks it loads on demand. */
function featuresIn({ modules, lazyModules, code }: AppBundle, lazy = false): string[] {
  const keys = new Set((lazy ? lazyModules : modules).map(moduleKey));
  if (lazy) code = '';
  const markers: Record<string, readonly (string | RegExp)[]> = Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, FEATURES[feature].markers]));
  return sorted(FEATURE_NAMES.filter((feature) => markers[feature]!.some((marker) => (typeof marker === 'string' ? keys.has(marker) : marker.test(code)))));
}

const bundles = new Map<string, AppBundle>();
const lowered: Partial<Record<Scenario, number>> = {};
const update = process.env.BESPOKE_SIZE_BUDGET === 'update';

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

describe('the client bundle stays within its budget (E75: a ratchet)', () => {
  it.each(Object.keys(SCENARIOS) as Scenario[])('%s', (name) => {
    const line = budget.gzipKB[name];
    expect(line, `${BUDGET_WHERE} has no limit for "${name}"`).toBeDefined();
    const size = kb(bundle(name).gzip);
    let problem = budgetProblem(name, size, line);
    if (problem && update && size < line.limit) {
      lowered[name] = limitFor(size);
      problem = undefined;
    }
    expect(problem).toBeUndefined();
  });

  it('the budget file only names scenarios this test builds', () => {
    expect(Object.keys(budget.gzipKB).sort()).toEqual(Object.keys(SCENARIOS).sort());
    expect(Object.keys(budget.stillLeaking).sort()).toEqual(['core', 'emptyApp', 'minimalApp']);
  });
});

describe('an app holds only the features it uses (E75: leak test)', () => {
  // `stillLeaking` lists what is in there today without being used; Wave 5c shrinks it to []. A new leak fails, and so
  // does a listed one that is gone — then take it off the list.
  it.each(['core', 'emptyApp', 'minimalApp'] as const)('%s', (name) => {
    const leaking = featuresIn(bundle(name)).filter((feature) => !USES[name].includes(feature));
    expect(leaking, `Features in "${name}" it does not use — update stillLeaking.${name} in ${BUDGET_WHERE} only when one is gone`).toEqual(
      sorted(budget.stillLeaking[name]),
    );
  });

  // Taken out of the default registration in Wave 5c step 4 (E70, E74): in none of these unless it is used — whatever
  // stillLeaking says (a feature may not come back onto that list).
  it.each(EXTRACTED)('%s is in no scenario that does not use it', (feature) => {
    for (const name of ['core', 'emptyApp', 'minimalApp'] as const) {
      if (USES[name].includes(feature)) continue;
      expect(featuresIn(bundle(name)), `${feature} in "${name}"`).not.toContain(feature);
    }
  });

  // E71: whatever an app imports, the layers are a chunk the core loads when the server answers with one — never in the first
  // download, and always there to load (a layer may answer any visit, E53).
  it.each(['core', 'emptyApp', 'minimalApp', 'everything'] as const)('the layers are a chunk of their own in %s — loaded on demand', (name) => {
    const built = bundle(name);
    expect(featuresIn(built)).not.toContain('layers');
    expect(featuresIn(built, true)).toContain('layers');
  });

  // W5c.6 / W6.9: the XHR code is no part of any first download — the core loads it with the first FormData visit with progress.
  it('the core alone carries uploads only in a chunk it loads on demand', () => {
    expect(featuresIn(bundle('core'))).not.toContain('uploads');
    expect(featuresIn(bundle('core'), true)).toContain('uploads');
  });

  // W6.10: an answer may follow a live channel whatever the app imported — the core loads the feature then (server-driven, like the
  // layers): never in a first download, always there to load.
  it.each(['core', 'emptyApp', 'minimalApp', 'everything'] as const)('live props are a chunk of their own in %s — loaded on demand', (name) => {
    const built = bundle(name);
    expect(featuresIn(built)).not.toContain('live');
    expect(featuresIn(built, true)).toContain('live');
  });

  it('a view that asks useLayer() and an app frame of LayerDialog bring no layer code into the first download', async () => {
    const built = await appBundle(appEntry('useLayer', 'LayerDialog'));
    expect(featuresIn(built)).toEqual(sorted(USES.emptyApp));
    expect(built.modules).toEqual(expect.arrayContaining(['react/dist/layer.js', 'react/dist/layer-dialog.js']));
  });

  it('the web app opens its layers from a chunk of their own: the core’s layers and the React layer stack', async () => {
    const node = process.env.NODE_ENV;
    try {
      const built = await appClientBuild(join(PACKAGES, '../apps/web-app'));
      expect(featuresIn(built)).not.toContain('layers');
      expect(built.lazyModules).toEqual(expect.arrayContaining(['http/dist/client/features/layers.js', 'http/dist/client/layer.js', 'react/dist/layer-stack.js']));
    } finally {
      process.env.NODE_ENV = node;
    }
  }, 60_000);

  it.each(FEATURE_NAMES)('%s comes with its own import — and recognisably so', (feature) => {
    const { use, brings = [], lazy = false }: { use: { base: LeakScenario }; brings?: readonly string[]; lazy?: boolean } = FEATURES[feature];
    const built = bundle(`feature:${feature}`);
    // A feature loaded on first use (E74) comes with its component, but in a chunk of its own — not in the first download.
    expect(featuresIn(built)).toEqual(sorted([...USES[use.base], ...budget.stillLeaking[use.base], ...(lazy ? [] : [feature]), ...brings]));
    if (lazy) expect(featuresIn(built, true)).toContain(feature);
  });
});

describe('no injection metadata in the browser (E76)', () => {
  it('no bundle carries an injection list or reason', () => {
    for (const [name, { code }] of bundles) {
      expect(code.match(/bespokecore\.injection[^"'`]*|static inject\b|Cannot inject[^"'`]{0,60}/)?.[0], name).toBeUndefined();
    }
  });

  it('the browser lists in package.json cover every module a browser entry bundles', async () => {
    const entries = [
      `import * as client from '@bespokecore/http/client';\nimport * as page from '@bespokecore/http/page';\nglobalThis.__keep = { client, page };\n`,
      `import * as react from '@bespokecore/react';\nimport * as messages from '@bespokecore/i18n/messages';\nglobalThis.__keep = { react, messages };\n`,
    ];
    const modules = (await Promise.all(entries.map((entry) => appBundle(entry, { external: /^react(-dom)?(\/|$)/ })))).flatMap((built) => built.modules);
    const uncovered = modules.filter((id) => {
      const [name, ...rest] = id.split('/');
      if (id === '(entry)' || name === 'router') return false; // @bespokecore/router/url: no classes, no injection
      // dist/x.js → src/x.ts(x): what package.json's globs name
      const source = ['.ts', '.tsx'].map((ext) => rest.join('/').replace(/^dist\//, 'src/').replace(/\.js$/, ext)).find((file) => existsSync(join(PACKAGES, name!, file)));
      const globs: string[] = JSON.parse(readFileSync(join(PACKAGES, name!, 'package.json'), 'utf8')).bespoke?.browser ?? [];
      return !source || !globs.some((glob) => matchesGlob(source, glob));
    });
    expect(uncovered, 'Browser modules outside their package\'s "bespoke": { "browser": [...] } — add them there (E76)').toEqual([]);
  }, 60_000);
});

describe('a production bundle says codes, not explanations (E80)', () => {
  // A few of the explanations the development build throws or warns: none may ship. A production error is its code
  // and a name (`[bespoke:R2] users/Show`); packages/http/README.md ("Error codes") says what each code means.
  const EXPLANATIONS = [
    'the browser has no route manifest',
    'is not defined in the browser',
    'has an invalid layout',
    'must be used inside <BespokeApp>',
    'needs the app\'s messages',
    'Hydration mismatch',
    'has no heading (h1–h3)',
    'islands cannot change the document head',
    'needs an interval above 0 ms',
    'is for the view of an island',
    'there is no navigator while rendering on the server',
  ];

  it.each(['core', 'emptyApp', 'minimalApp', 'everything'] as const)('%s', (name) => {
    const { code, lazyCode } = bundle(name);
    expect(EXPLANATIONS.filter((text) => `${code}\n${lazyCode}`.includes(text))).toEqual([]);
  });

  it('the full bundle throws the codes instead', () => {
    const codes = new Set(bundle('everything').code.match(/\[bespoke:[CR]\d+\]/g));
    for (const code of ['C1', 'C2', 'R1', 'R2', 'R9', 'R10', 'R12']) expect(codes, code).toContain(`[bespoke:${code}]`);
  });

  it('every code is in the README once, and every code there is thrown', () => {
    const sources = (dir: string) =>
      readdirSync(join(PACKAGES, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$|__fixtures__|test-window/.test(file))
        .map((file) => readFileSync(join(PACKAGES, dir, file), 'utf8'));
    const used = sorted([...sources('http/src/client'), ...sources('react/src')].flatMap((text) => [...text.matchAll(/\[bespoke:([CR]\d+)\]/g)].map((match) => match[1]!)));
    const rows = [...readFileSync(join(PACKAGES, 'http/README.md'), 'utf8').matchAll(/^\| ([CR]\d+) \|/gm)].map((match) => match[1]!);
    expect(rows.length, 'a code listed twice in packages/http/README.md').toBe(new Set(rows).size);
    expect(sorted(rows)).toEqual(used);
  });
});
