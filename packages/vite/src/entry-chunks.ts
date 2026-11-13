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
 * How one client build with several entries splits what each entry loads first. The keys of `entries` are the module ids of the
 * entries (`<root>/index.html`, a package's client entry), the values their names (`index`, `pkg-<namespace>`).
 *
 * A module that only one entry reaches, through any import, goes into that entry's chunk (`index`/`vendor` for the app, `pkg-<namespace>`/
 * `vendor-pkg-<namespace>` for a package). A module that several reach goes into a chunk shared by exactly that combination, so no entry
 * loads first what only another entry needs. File names carry a hash of the combination, never a namespace.
 *
 * One pair of groups per number of entries that reach a module, from all of them down to two, each with a priority above the next: a
 * dependency is reached by at least the entries that reach its importer, so a larger combination is placed first and a group only ever pulls
 * along a dependency of the same combination.
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
  const shared = (prefix: string, size: number) => (id: string, ctx: Rolldown.ChunkingContext) => {
    const found = of(id, ctx);
    return found !== undefined && found.any.length === size ? `${prefix}-${hash(found)}` : null;
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
      ...[...Array(entries.size - 1).keys()].map((i) => entries.size - i).flatMap((size) => [
        { name: shared('vendor-shared', size), test: isThirdParty, tags: ['$initial'] as Rolldown.BuiltinModuleTag[], priority: 2 + 2 * size },
        { name: shared('shared', size), tags: ['$initial'] as Rolldown.BuiltinModuleTag[], priority: 1 + 2 * size },
      ]),
      { name: alone(true), test: isThirdParty, tags: ['$initial'], priority: 2 },
      { name: alone(false), tags: ['$initial'], priority: 1 },
    ],
  };
}
