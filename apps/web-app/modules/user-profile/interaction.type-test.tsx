/**
 * Type guarantees of flash messages, state attributes, the navigation guard and confirm against this app's
 * `FlashData` and routes — checked by `tsc` (`pnpm typecheck`, `marmeon build`), never run. Each `@ts-expect-error` is a
 * mistake an app developer makes; the comment above it is the message they get (read with the directive removed).
 */
import { Controller, type HttpContext } from '@marmeon/http';
import { Link, useAction, useFlash, useForm, usePending } from '@marmeon/react';
import type { TestApp } from '@marmeon/testing';
import { expectTypeOf } from 'vitest';

export class FlashingController extends Controller {
  handle(ctx: HttpContext<{}, { user: string }>) {
    // Typed by `interface FlashData` (middleware/ShareAppProps.ts).
    if (ctx.params.user === 'me') return this.redirect('/').flash('toast', { kind: 'success', message: 'Saved.' });
    // Argument of type '"tost"' is not assignable to parameter of type '"'tost' is not a flash key — the app declares toast
    // (interface FlashData of @marmeon/http/page)"'.
    // @ts-expect-error
    if (ctx.params.user === 'a') return this.back().flash('tost', { kind: 'success', message: 'Saved.' });
    // Type '"ok"' is not assignable to type '"error" | "info" | "success"'.
    // @ts-expect-error
    if (ctx.params.user === 'b') return this.back().flash('toast', { kind: 'ok', message: 'Saved.' });
    // Property 'message' is missing in type '{ kind: "info"; }' but required in type '{ kind: "error" | "info" | "success"; message: string; }'.
    // @ts-expect-error
    if (ctx.params.user === 'c') return this.back().flash('toast', { kind: 'info' });
    // A page and an action's JSON carry their own.
    if (ctx.params.user === 'd') return this.json({ done: true }).flash('toast', { kind: 'info', message: 'Done.' });
    return this.view('user-profile/People', {}).flash('toast', { kind: 'error', message: 'Nope.' });
  }
}

export function Toasts() {
  // The data is the declared type.
  useFlash('toast', (toast, message) => {
    expectTypeOf(toast).toEqualTypeOf<{ kind: 'success' | 'error' | 'info'; message: string }>();
    expectTypeOf(message.id).toEqualTypeOf<string>();
  });
  // Argument of type '"tost"' is not assignable to parameter of type '"'tost' is not a flash key — the app declares toast (…)"'.
  // @ts-expect-error
  useFlash('tost', () => {});
  return null;
}

export function States() {
  const form = useForm('user-profile.update', { user: 1 }, { name: '', bio: '' }, { guard: true });
  form.isDirty();
  form.isDirty('bio');
  // Argument of type '"bioo"' is not assignable to parameter of type '"bio" | "name" | undefined'.
  // @ts-expect-error
  form.isDirty('bioo');
  usePending('user-profile.update', { delay: 'short' });
  // Argument of type '"user-profile.updte"' is not assignable to parameter of type '"'user-profile.updte' is not a route name — did you mean user-profile.update?"'.
  // @ts-expect-error
  usePending('user-profile.updte');
  const remove = useAction('user-profile.links.destroy');
  void remove.submit({ params: { user: 1, link: 2 }, confirm: { message: 'Remove it?', prompt: 'REMOVE' } });
  // Type 'number' is not assignable to type 'string'. (the text to type: `prompt`)
  // @ts-expect-error
  void remove.submit({ params: { user: 1, link: 2 }, confirm: { message: 'Remove it?', prompt: 42 } });
  return (
    <>
      <Link route="user-profile.people" activeMatch="user-profile.*">
        People
      </Link>
      <Link route="dashboard.show" activeMatch={['dashboard.show', 'user-profile.people']}>
        Dashboard
      </Link>
      {/* Type '"user-profil.*"' is not assignable to type 'readonly ActiveMatch[] | ActiveMatch | undefined'. Did you mean '"user-profile.*"'? */}
      {/* @ts-expect-error */}
      <Link route="user-profile.people" activeMatch="user-profil.*">
        People
      </Link>
      <Link route="user-profile.links.destroy" params={{ user: 1, link: 2 }} confirm="Remove this link?">
        Remove
      </Link>
      {/* Object literal may only specify known properties, but 'promt' does not exist in type 'ConfirmOptions'. Did you mean to write 'prompt'? */}
      {/* @ts-expect-error */}
      <Link route="user-profile.links.destroy" params={{ user: 1, link: 2 }} confirm={{ message: 'Remove?', promt: 'REMOVE' }}>
        Remove
      </Link>
      {/* Type '{ prompt: string; }' is not assignable to type 'Confirm | undefined'. (a question needs its `message`) */}
      {/* @ts-expect-error */}
      <Link route="user-profile.links.destroy" params={{ user: 1, link: 2 }} confirm={{ prompt: 'REMOVE' }}>
        Remove
      </Link>
    </>
  );
}

export async function Tests(app: TestApp) {
  await app.get('/').assertFlash('toast', { message: 'Saved.' });
  // Argument of type '"tost"' is not assignable to parameter of type '"'tost' is not a flash key — the app declares toast (…)"'.
  // @ts-expect-error
  await app.get('/').assertFlash('tost');
  // Type '"ok"' is not assignable to type '"error" | "info" | "success" | undefined'.
  // @ts-expect-error
  await app.get('/').assertFlash('toast', { kind: 'ok' });
}
