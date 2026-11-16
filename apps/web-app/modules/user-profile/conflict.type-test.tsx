/**
 * Type guarantees of a controller's conflict against this app's routes — checked by `tsc` (`pnpm typecheck`), never run.
 * `user-profile.links.rename` answers `this.json(…)` or `conflict(…)` — whose `current` may be `undefined` (the link is gone); `user-profile.links.destroy` only redirects.
 */
import { conflict, Controller, type PageProps } from '@marmeon/http';
import type { SearchProfileLinksController } from './controllers/SearchProfileLinksController.ts';
import type { UpdateProfileLinkController } from './controllers/UpdateProfileLinkController.ts';
import { Form, useAction, useForm, type FormRenderState } from '@marmeon/react';
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

/** A route form carries the conflict of its controller: `current` is what JSON makes of `conflict(current)`; a route that never answers one has none. */
export function RenameForm() {
  const form = useForm('user-profile.links.update', { label: 'Blog', seen: '2026-01-01T00:00:00.000Z' }, { params: { user: 1, link: 2 } });
  expectTypeOf(form.conflict).toEqualTypeOf<{ readonly message: string; readonly current: { label: string; savedAt: string } | undefined } | undefined>();
  void form.submit({
    onConflict: (found) => {
      expectTypeOf(found.message).toEqualTypeOf<string>();
      expectTypeOf(found.current).toEqualTypeOf<{ label: string; savedAt: string } | undefined>();
    },
  });

  const plain = useForm('user-profile.update', { name: 'Ada' }, { params: { user: 1 } });
  expectTypeOf(plain.conflict).toEqualTypeOf<{ readonly message: string; readonly current: undefined } | undefined>();
  return (
    <Form route="user-profile.links.update" params={{ user: 1, link: 2 }} onConflict={(found) => expectTypeOf(found.current).toEqualTypeOf<{ label: string; savedAt: string } | undefined>()}>
      {(state) => {
        expectTypeOf(state.conflict?.message).toEqualTypeOf<string | undefined>();
        return null;
      }}
    </Form>
  );
}

type Found = { label: string; savedAt: string };

/** A form of a controller (`useForm<C>`) types its conflict from the controller, and `onConflict` of any submit with it. */
export function ByController() {
  const form = useForm<UpdateProfileLinkController>({ label: 'Blog', seen: '2026-01-01T00:00:00.000Z' });
  expectTypeOf(form.conflict).toEqualTypeOf<{ readonly message: string; readonly current: Found | undefined } | undefined>();
  void form.put('/users/1/links/2', {
    onConflict: (found) => expectTypeOf(found.current).toEqualTypeOf<Found | undefined>(),
  });
  return null;
}

/** What the render function of `<Form>` gets: the conflict with the `C` of the route, `unknown` where none is given. */
export function RenderState() {
  expectTypeOf<FormRenderState<{ label: string }, Found>['conflict']>().toEqualTypeOf<{ readonly message: string; readonly current: Found | undefined } | undefined>();
  expectTypeOf<FormRenderState<{ label: string }>['conflict']>().toEqualTypeOf<{ readonly message: string; readonly current: unknown } | undefined>();
  return (
    <Form route="user-profile.links.update" params={{ user: 1, link: 2 }}>
      {(state) => {
        expectTypeOf(state.conflict).toEqualTypeOf<{ readonly message: string; readonly current: Found | undefined } | undefined>();
        return null;
      }}
    </Form>
  );
}

/** `_conflict` is the session's shared prop: a page reads it as it arrives, and cannot set one of its own. */
export class OwnConflictProp extends Controller {
  handle() {
    // Type 'number' is not assignable to type 'undefined'.
    // @ts-expect-error
    return this.view('user-profile/Links', { _conflict: 1 });
  }
}
expectTypeOf<PageProps<SearchProfileLinksController>['_conflict']>().toEqualTypeOf<{ message: string; current?: unknown } | null>();
