/**
 * Type guarantees of actions and optimistic UI against this app's routes — checked by `tsc` (`pnpm typecheck`,
 * `marmeon build`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the comment above it is the message
 * they get (read with the directive removed).
 */
import { useAction, useIsland, usePendingSubmissions, useRouter, type RevalidateOnBack } from '@marmeon/react';
import { expectTypeOf } from 'vitest';
import type { ShowAccessTokensController } from '../auth/controllers/ShowAccessTokensController.ts';
import type { ShowRecentSignInsController } from '../dashboard/controllers/ShowRecentSignInsController.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

export function Actions() {
  const router = useRouter<ShowUserProfileController>();
  const remove = useAction('user-profile.links.destroy');
  const add = useAction('user-profile.links.store', { user: 1 });
  const revoke = useAction('auth.tokens.destroy');

  async function typed() {
    // The answer is typed by the controller: `this.json({ revoked: id })` → `data: { revoked: number }`.
    const result = await revoke.submit({ params: { token: 1 } });
    if (result.ok && result.kind === 'data') expectTypeOf(result.data).toEqualTypeOf<{ revoked: number }>();
    // A controller that only redirects has no data branch: its success is `{ kind: 'redirect' }`.
    const removed = await remove.submit({ params: { user: 1, link: 2 } });
    if (removed.ok) expectTypeOf(removed.kind).toEqualTypeOf<'redirect'>();
    // Errors by the fields of the request schema.
    const added = await add.submit({ data: { label: 'Blog', url: 'https://blog.example' } });
    if (added.kind === 'invalid') expectTypeOf(added.errors).toEqualTypeOf<Partial<Record<'label' | 'url', string>>>();
    expectTypeOf(usePendingSubmissions('user-profile.links.store')[0]!.input).toEqualTypeOf<{ label: string; url: string }>();
    expectTypeOf(usePendingSubmissions('auth.passkeys.destroy')[0]!.input.password).toEqualTypeOf<string | undefined>();
    // An action's own submissions hold the data they were passed, so a call's input goes back into submit().
    const destroy = useAction('auth.passkeys.destroy', { passkey: '1' });
    expectTypeOf(destroy.submissions[0]!.input).toEqualTypeOf<{ password?: string | undefined }>();

    // Argument of type '"user-profile.links.destory"' is not assignable to parameter of type '"'user-profile.links.destory' is not a
    // route name — did you mean user-profile.links.destroy?"'.
    // @ts-expect-error
    useAction('user-profile.links.destory');
    // … '"'user-profile.show' answers with a page — visit it (<Link>, useForm); an action's controller returns this.json(…) or a redirect"'.
    // @ts-expect-error
    useAction('user-profile.show');
    // … '"'dashboard.sign-ins' is an island — embed it with <Island route=\"dashboard.sign-ins\">; an action calls a route that answers
    // this.json(…) or a redirect"'.
    // @ts-expect-error
    useAction('dashboard.sign-ins');
    // Object literal may only specify known properties, but 'lable' does not exist in type '{ label: string; url: string; }'. Did you
    // mean to write 'label'?
    // @ts-expect-error
    await add.submit({ data: { lable: 'Blog', url: 'https://blog.example' } });
    // Type '{ name: string; }' is not assignable to type '"'auth.tokens.destroy' takes no body — its controller has no request schema
    // (or it is a GET: pass `query`)"'.
    // @ts-expect-error
    await revoke.submit({ params: { token: 1 }, data: { name: 'x' } });
    // Property 'params' is missing in type '{}' but required in type '{ params: { link: Param; user: Param; }; }'.
    // @ts-expect-error
    await remove.submit({});
    // Property 'deleted' does not exist on type '{ revoked: number; }'.
    // @ts-expect-error
    if (result.ok && result.kind === 'data') void result.data.deleted;

    // Patches, typed against the page.
    await remove.submit({
      params: { user: 1, link: 2 },
      optimistic: router.optimistic((props) => ({ profile: { ...props.profile, links: props.profile.links.filter((link) => link.id !== 'link-id') } })),
      reload: router.reloading({ only: ['profile'] }),
    });
    // … Types of property 'profle' are incompatible. Type 'null' is not assignable to type '"'profle' is not a prop of this page"'.
    // @ts-expect-error
    router.optimistic(() => ({ profle: null }));
    // … The types of 'profile.links' are incompatible between these types. Type 'number' is not assignable to type '{ id: number;
    // label: string; url: string; }[]'.
    // @ts-expect-error
    router.optimistic((props) => ({ profile: { ...props.profile, links: 5 } }));
    // Type '"activty"' is not assignable to type '"abilities" | "activity" | "auth" | … | "stats"'. Did you mean '"activity"'?
    // @ts-expect-error
    router.reloading({ only: ['activty'] });
    // Type '"dashboard.sign-in"' is not assignable to type '"'dashboard.sign-in' is not a route name — did you mean dashboard.show,
    // dashboard.sign-ins?"'.
    // @ts-expect-error
    router.reloading({ islands: ['dashboard.sign-in'] });
    // … '"'user-profile.show' renders a page, not an island — its controller returns this.view(…); an island's returns this.island(…)"'.
    // @ts-expect-error
    router.reloading({ islands: ['user-profile.show'] });
  }
  void typed;
  return null;
}

export function Tokens() {
  const router = useRouter<ShowAccessTokensController>();
  // … Types of property 'tokens' are incompatible. Type 'string[]' is not assignable to type '{ readonly id: number; … }[]'.
  // @ts-expect-error
  router.optimistic((props) => ({ tokens: props.tokens.map((token) => token.name) }));
  return null;
}

export function SignIns() {
  const island = useIsland<ShowRecentSignInsController>();
  island.optimistic((props) => ({ entries: props.entries.slice(1) }));
  // Type '"entires"' is not assignable to type '"entries" | "now"'. Did you mean '"entries"'?
  // @ts-expect-error
  island.reloading({ only: ['entires'] });
  return null;
}

export const declared = ['activity'] as const satisfies RevalidateOnBack<ShowUserProfileController>;
export const island = ['entries', 'now'] as const satisfies RevalidateOnBack<ShowRecentSignInsController>;
// Type '"activty"' is not assignable to type '"activity" | "auth" | … | "stats"'. Did you mean '"activity"'?
// @ts-expect-error
export const typo = ['activty'] as const satisfies RevalidateOnBack<ShowUserProfileController>;

/** A component's hook may return a call list without annotating it: the declaration can name every type in it (no TS2883). */
export function useDestroyCalls() {
  return [useAction('auth.passkeys.destroy', { passkey: '1' }).submissions, usePendingSubmissions('auth.passkeys.destroy')];
}
