import { existsSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appBundle,
  appEntry,
  BUDGET_WHERE,
  budgetProblem,
  coreEntry,
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
 * What each scenario uses on purpose: `createBespokeApp` turns the progress bar on; `useForm` remembers a form's input
 * (`remember`, static in it — E74 loads only `validate` on first use).
 */
const USES: Record<Scenario, readonly string[]> = { core: [], emptyApp: ['progress'], minimalApp: ['progress', 'remember'], everything: [] };

/** A feature's entry: the scenario it adds to, plus its import. */
const inCore = (...names: string[]) => ({ base: 'core' as const, entry: coreEntry(...names) });
const inApp = (...names: string[]) => ({ base: 'emptyApp' as const, entry: appEntry(...names) });

/**
 * The optional features and how to recognise them in a bundle: by module (`<package>/<path>` without src/dist and
 * extension) — the navigator's part of each lives in `http/client/features/` since Wave 5c step 2. Step 4 takes them out
 * of the default registration one by one (those still in it are `stillLeaking`): then the hook or component that uses one
 * attaches it. `use` is the import an app uses it through, on top of a scenario; `brings`, the features it builds on.
 */
const FEATURES = {
  layers: { markers: ['http/client/features/layers', 'http/client/layer', 'react/layer'], use: inApp('LayerDialog') },
  islands: { markers: ['http/client/features/islands', 'http/client/region', 'react/island'], use: inApp('Island'), brings: ['poll'] }, // <Island poll>
  actions: { markers: ['http/client/features/actions', 'http/client/features/optimistic', 'http/client/action', 'http/client/optimistic', 'react/use-action'], use: inApp('useAction') },
  liveValidation: { markers: ['http/client/live-validation'], use: inApp('useForm'), brings: ['remember'] }, // useForm remembers (static)
  queryState: { markers: ['http/client/features/query-state', 'react/use-query-state'], use: inApp('useQueryState') },
  remember: { markers: ['http/client/remember', 'http/client/features/remember', 'react/remember'], use: inApp('useRemember') },
  poll: { markers: ['http/client/poll', 'react/use-poll', 'react/when-visible'], use: inApp('usePoll') },
  progress: { markers: ['http/client/progress'], use: inCore('showProgress') },
  prefetch: { markers: ['http/client/features/prefetch'], use: inApp('Link') },
  revalidateOnBack: { markers: ['http/client/features/revalidate-on-back'], use: inApp('resolveModulePages') },
  guard: { markers: ['http/client/features/guard', 'http/client/confirm', 'react/confirm'], use: inApp('useBlocker') },
  instant: { markers: ['http/client/features/instant'], use: inApp('Link') },
  form: { markers: ['react/form'], use: inApp('Form'), brings: ['remember'] }, // <Form remember>, static like useForm's
  pagination: { markers: ['react/pagination'], use: inApp('Pagination') },
} satisfies Record<string, { markers: readonly (string | RegExp)[]; use: { base: LeakScenario; entry: string }; brings?: readonly string[] }>;
type Feature = keyof typeof FEATURES;
const FEATURE_NAMES = Object.keys(FEATURES) as Feature[];

/** The features Wave 5c step 4 took out of every app that does not use them, one commit each. */
const EXTRACTED: readonly Feature[] = ['queryState', 'remember'];

/** `http/dist/client/layer.js` → `http/client/layer`. */
const moduleKey = (id: string) => id.replace(/^([^/]+)\/(?:src|dist)\//, '$1/').replace(/\.[cm]?[jt]sx?$/, '');

const sorted = (features: Iterable<string>) => [...new Set(features)].sort();

/** The features a bundle holds, sorted. */
function featuresIn({ modules, code }: AppBundle): string[] {
  const keys = new Set(modules.map(moduleKey));
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

  it.each(FEATURE_NAMES)('%s comes with its own import — and recognisably so', (feature) => {
    const { use, brings = [] }: { use: { base: LeakScenario }; brings?: readonly string[] } = FEATURES[feature];
    expect(featuresIn(bundle(`feature:${feature}`))).toEqual(sorted([...USES[use.base], ...budget.stillLeaking[use.base], feature, ...brings]));
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
