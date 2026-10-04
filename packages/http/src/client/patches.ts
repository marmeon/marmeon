/**
 * Applying and rolling back a visit's or an action's optimistic patches (E59) — on whatever target they are for (the page of
 * a history entry, a layer, an island): a module of its own, so the core can apply a visit's patches without carrying the
 * patch queues of the targets (`optimistic.ts`), which come with the features that make them.
 */
import type { DevtoolsGlobal } from './features/devtools.ts';
import type { OptimisticUpdate, PatchTarget } from './optimistic.ts';

/** One or several (`optimistic`, `reload` of a visit or an action) as a list. */
export function listOf<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/** Applies the patches of an action (or a form's visit) — their ids by target. */
export function applyPatches(updates: readonly OptimisticUpdate[]): Map<PatchTarget, number[]> {
  const applied = new Map<PatchTarget, number[]>();
  for (const { target, patch } of updates) {
    const ids = applied.get(target) ?? [];
    ids.push(target.add(patch));
    applied.set(target, ids);
  }
  // Development only (W7 step 9): the devtools' bar shows them with the request they go with — gone from a production build.
  if (process.env.NODE_ENV !== 'production' && applied.size > 0) (globalThis as DevtoolsGlobal).__BESPOKE_DEVTOOLS_HOOK__?.patches?.([...applied.values()].flat());
  return applied;
}

/** Rolls the patches of an action (or a form's visit) back. */
export function rollBack(applied: ReadonlyMap<PatchTarget, readonly number[]>): void {
  for (const [target, ids] of applied) target.settle(ids, false);
}
