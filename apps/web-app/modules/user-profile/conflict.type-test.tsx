/**
 * Type guarantees of a controller's conflict against this app's routes — checked by `tsc` (`pnpm typecheck`), never run.
 * `user-profile.links.rename` answers `this.json(…)` or `conflict(…)` — whose `current` may be `undefined` (the link is gone); `user-profile.links.destroy` only redirects.
 */
import { conflict } from '@marmeon/http';
import { useAction } from '@marmeon/react';
import { expectTypeOf } from 'vitest';

export function Rename() {
  const rename = useAction('user-profile.links.rename', { user: 1, link: 2 });
  const destroy = useAction('user-profile.links.destroy', { user: 1, link: 2 });

  async function typed() {
    const result = await rename.submit({ data: { label: 'Blog', seen: '2026-01-01T00:00:00.000Z' } });
    // `current` is what JSON makes of it: the `Date` is its string; `data` has no conflict in it.
    if (result.kind === 'conflict') {
      expectTypeOf(result.current).toEqualTypeOf<{ label: string; savedAt: string } | undefined>();
      expectTypeOf(result.message).toEqualTypeOf<string>();
    }
    if (result.ok && result.kind === 'data') expectTypeOf(result.data).toEqualTypeOf<{ label: string; updated_at: string }>();
    expectTypeOf(rename.conflict).toEqualTypeOf<{ label: string; savedAt: string } | undefined>();
    expectTypeOf(rename.result).toExtend<{ readonly kind: string } | undefined>();
    expectTypeOf(rename.data).toEqualTypeOf<{ label: string; updated_at: string } | undefined>();

    // A route that cannot answer with a conflict has no such kind, and its `conflict` is never set.
    const removed = await destroy.submit();
    // This comparison appears to be unintentional because the types '"redirect" | "invalid" | "exception" | "cancelled"' and
    // '"conflict"' have no overlap.
    // @ts-expect-error
    if (removed.kind === 'conflict') void removed;
    expectTypeOf(destroy.conflict).toEqualTypeOf<undefined>();
  }
  void typed;
  return null;
}

// Argument of type 'string' is not assignable to parameter of type '{ message?: string }'.
// @ts-expect-error
export const keyAsString = conflict({ version: 1 }, 'notes.stale');
