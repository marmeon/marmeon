/**
 * `pnpm size` — where the bytes of the client core and the React adapter go (Wave 5c, E75): the scenarios of
 * `bundle-size.test.ts` and the real apps' client builds, every byte attributed to its module by source map — and the
 * marginal cost of core + adapter (gzip with and without their bytes), which module granularity does not distort.
 * Checks the apps' marginal cost of core + adapter against `appsGzipKB` in `packages/react/size-budget.json` (the scenarios are
 * `pnpm test`'s job). Marginal, not the attributed share: the share is a scaled stand-alone gzip per module, which grows with
 * the number of modules (Wave 5c step 2: +2.96 KB attributed for +1.05 KB real) — it would punish splitting the core up.
 * Measures `dist/` — run `pnpm build` first. Nothing is written.
 *
 *   pnpm size                 # scenarios and apps
 *   pnpm size web-app         # one app (or scenario), with every module
 *   BESPOKE_SIZE_BUDGET=update pnpm size   # lower the apps' limits that the sizes undercut
 */
import { join } from 'node:path';
import {
  appBundle,
  appClientBuild,
  budgetProblem,
  kb,
  limitFor,
  lowerLimits,
  PACKAGES,
  readBudget,
  SCENARIOS,
  type AppBundle,
  type ModuleShare,
  type Scenario,
} from './bundle.ts';

const APPS = ['blank-app', 'web-app'];
const only = process.argv.slice(2);
const wanted = (name: string) => only.length === 0 || only.includes(name);
const budget = readBudget();

/** What a module belongs to, for the summary. */
function groupOf(module: string): string {
  if (/^http\/(dist|src)\/(client\/|page\.)/.test(module) || /^router\/(dist|src)\/url\./.test(module)) return 'client core';
  if (module.startsWith('react/')) return 'React adapter';
  if (module.startsWith('i18n/')) return 'i18n';
  if (/^node_modules\/(react-dom|scheduler)\//.test(module)) return 'react-dom';
  if (module.startsWith('node_modules/react/')) return 'react';
  if (module.startsWith('node_modules/')) return 'other packages';
  if (module.startsWith('(')) return module;
  return 'app';
}

const FRAMEWORK = new Set(['client core', 'React adapter']);
const format = (share: ModuleShare) => `${(share.min / 1024).toFixed(1).padStart(6)} min ${(share.gzip / 1024).toFixed(2).padStart(6)} gzip`;

function groups(attribution: ReadonlyMap<string, ModuleShare>): Map<string, ModuleShare> {
  const total = new Map<string, ModuleShare>();
  for (const [module, share] of attribution) {
    const group = groupOf(module);
    const sum = total.get(group) ?? { min: 0, gzip: 0 };
    total.set(group, { min: sum.min + share.min, gzip: sum.gzip + share.gzip });
  }
  return total;
}

function print(key: string, title: string, bundle: AppBundle, { top }: { top: number }): number {
  const { initial, lazy } = bundle.attribution!;
  console.log(`\n${title} — initial ${(bundle.min / 1024).toFixed(1)} KB min / ${(bundle.gzip / 1024).toFixed(2)} KB gzip in ${bundle.initial.length} chunk(s)` +
    (bundle.lazy.length ? `, ${bundle.lazy.length} lazy chunk(s) ${(bundle.lazy.reduce((sum, chunk) => sum + chunk.gzip, 0) / 1024).toFixed(2)} KB gzip` : ''));
  const initialGroups = groups(initial);
  const lazyGroups = groups(lazy);
  for (const [group, share] of [...initialGroups].sort((a, b) => b[1].gzip - a[1].gzip)) {
    const later = lazyGroups.get(group);
    console.log(`  ${group.padEnd(16)} ${format(share)}${later ? `   (+ lazy ${format(later)})` : ''}`);
  }
  const framework = [...initial].filter(([module]) => FRAMEWORK.has(groupOf(module))).sort((a, b) => b[1].gzip - a[1].gzip);
  const sum = framework.reduce((total, [, share]) => ({ min: total.min + share.min, gzip: total.gzip + share.gzip }), { min: 0, gzip: 0 });
  console.log(`  ${'core + adapter'.padEnd(16)} ${format(sum)}`);
  // The shares above are scaled stand-alone gzips: more, smaller modules inflate them. The marginal cost does not.
  const marginal = bundle.attribution!.marginalGzip((module) => FRAMEWORK.has(groupOf(module)));
  console.log(`  ${'  marginal'.padEnd(16)} ${(marginal / 1024).toFixed(2).padStart(17)} gzip  (what the download loses without core + adapter)`);
  for (const [module, share] of framework.slice(0, top)) console.log(`    ${module.padEnd(44)} ${format(share)}`);
  if (framework.length > top) console.log(`    … ${framework.length - top} more (pnpm size ${key})`);
  return marginal;
}

const problems: string[] = [];
const lowered: Record<string, number> = {};
const update = process.env.BESPOKE_SIZE_BUDGET === 'update';
const top = only.length ? Infinity : 8;

for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
  if (!wanted(scenario)) continue;
  const bundle = await appBundle(SCENARIOS[scenario], { sourcemap: true });
  print(scenario, `scenario ${scenario} (limit ${budget.gzipKB[scenario].limit.toFixed(1)})`, bundle, { top });
}

for (const app of APPS) {
  if (!wanted(app)) continue;
  const bundle = await appClientBuild(join(PACKAGES, '../apps', app), { sourcemap: true });
  const line = budget.appsGzipKB[app];
  const marginal = print(app, `${app}${line ? ` (core + adapter marginal limit ${line.limit.toFixed(1)})` : ''}`, bundle, { top });
  if (!line) continue;
  const size = kb(marginal);
  const problem = budgetProblem(`${app}: core + adapter (marginal)`, size, line);
  if (problem && update && size < line.limit) lowered[app] = limitFor(size);
  else if (problem) problems.push(problem);
}

if (Object.keys(lowered).length > 0) {
  lowerLimits(lowered);
  console.log(`\nLowered: ${Object.entries(lowered).map(([name, limit]) => `${name} → ${limit.toFixed(1)}`).join(', ')}`);
}
for (const problem of problems) console.error(`\n✗ ${problem}`);
process.exitCode = problems.length > 0 ? 1 : 0;
