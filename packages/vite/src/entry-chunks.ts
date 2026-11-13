import { createHash } from 'node:crypto';
import type { Rolldown } from 'vite';

/** A module of a third-party package — not one of the framework's (`@marmeon/*`), not the app's own. */
export function isThirdParty(id: string): boolean {
  return /[\\/]node_modules[\\/]/.test(id) && !/[\\/]node_modules[\\/]@marmeon[\\/]/.test(id);
}

/** Which entries reach a module: `initial` through static imports only, `any` through every import, lazy ones included. */
interface Reach {
  initial: readonly string[];
  any: readonly string[];
}

/**
 * The (entries reaching a module, entries loading it first) pairs a shared module can have, from the lowest to the highest. A module's
 * static dependency is reached and loaded first by at least the same entries, so it never sits in a lower tier than its importer.
 */
function tiers(entries: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let size = 2; size <= entries; size++) for (let loaded = 0; loaded <= size; loaded++) pairs.push([size, loaded]);
  return pairs;
}

/**
 * How one client build with several entries splits what each entry loads first. The keys of `entries` are the module ids of the
 * entries (`<root>/index.html`, a package's client entry), the values their names (`index`, `pkg-<namespace>`).
 *
 * A module that only one entry reaches, through any import, goes into that entry's chunk (`index`/`vendor` for the app, `pkg-<namespace>`/
 * `vendor-pkg-<namespace>` for a package). A module that several reach goes into a chunk shared by exactly that combination, so no entry
 * loads first what only another entry needs. File names carry a hash of the combination, never a namespace.
 *
 * One pair of groups per tier of (entries that reach a module, entries that load it first), the higher tier with the higher priority: a
 * dependency is reached and loaded first by at least the entries that do so for its importer, so a group only ever pulls along a dependency
 * of the same combination. Code one entry imports lazily and another statically never ends up in the first load of the first.
 */
export function entryChunks(entries: ReadonlyMap<string, string>): Rolldown.CodeSplittingOptions {
  // Computed once per chunking context: a rebuild (watch mode) gets a context of its own and so reads its graph again.
  const runs = new WeakMap<object, Map<string, Reach>>();

  const compute = (ctx: Rolldown.ChunkingContext): Map<string, Reach> => {
    const initial = new Map<string, Set<string>>();
    const any = new Map<string, Set<string>>();
    for (const [entryId, name] of entries) {
      for (const [map, dynamic] of [[initial, false], [any, true]] as const) {
        const seen = new Set<string>();
        const stack = [entryId];
        for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
          if (seen.has(id)) continue;
          seen.add(id);
          let names = map.get(id);
          if (names === undefined) map.set(id, (names = new Set()));
          names.add(name);
          const info = ctx.getModuleInfo(id);
          if (info === null) continue;
          stack.push(...info.importedIds, ...(dynamic ? info.dynamicallyImportedIds : []));
        }
      }
    }
    return new Map([...any].map(([id, names]) => [id, { initial: [...(initial.get(id) ?? [])].sort(), any: [...names].sort() }]));
  };

  const of = (id: string, ctx: Rolldown.ChunkingContext): Reach | undefined => (runs.get(ctx) ?? runs.set(ctx, compute(ctx)).get(ctx)!).get(id);
  const hash = ({ initial, any }: Reach): string => createHash('sha256').update(`${initial.join('+')}|${any.join('+')}`).digest('hex').slice(0, 8);
  const shared = (prefix: string, size: number, loaded: number) => (id: string, ctx: Rolldown.ChunkingContext) => {
    const found = of(id, ctx);
    return found !== undefined && found.any.length === size && found.initial.length === loaded ? `${prefix}-${hash(found)}` : null;
  };
  // The app's chunk is `index` (`vendor` for third-party code), a package's `pkg-<namespace>` (`vendor-pkg-<namespace>`).
  const alone = (vendor: boolean) => (id: string, ctx: Rolldown.ChunkingContext) => {
    const found = of(id, ctx);
    if (found === undefined || found.any.length !== 1) return null;
    const name = found.any[0]!;
    if (!vendor) return name;
    return name === 'index' ? 'vendor' : `vendor-${name}`;
  };

  return {
    groups: [
      ...tiers(entries.size).flatMap(([size, loaded], rank) => [
        { name: shared('vendor-shared', size, loaded), test: isThirdParty, tags: ['$initial'] as Rolldown.BuiltinModuleTag[], priority: 2 * rank + 4 },
        { name: shared('shared', size, loaded), tags: ['$initial'] as Rolldown.BuiltinModuleTag[], priority: 2 * rank + 3 },
      ]),
      { name: alone(true), test: isThirdParty, tags: ['$initial'], priority: 2 },
      { name: alone(false), tags: ['$initial'], priority: 1 },
    ],
  };
}
