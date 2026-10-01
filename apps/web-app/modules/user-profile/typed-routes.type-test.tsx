/**
 * Type guarantees of typed routes and views (W5.2, E34/E40) against this app's generated `bootstrap/routes.ts` —
 * checked by `tsc` (`pnpm typecheck`), never run. Each `@ts-expect-error` is a mistake an app developer makes;
 * the comment above it is the message they get (read with the directive removed).
 */
import { authenticate } from '@bespokecore/auth';
import { Controller, UrlSigner, view } from '@bespokecore/http';
import { Link, useForm, useRoute } from '@bespokecore/react';
import { Router } from '@bespokecore/router';
import type { TestResponse } from '@bespokecore/testing';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import type { UpdateUserProfileController } from './controllers/UpdateUserProfileController.ts';

export function InTheBrowser() {
  const route = useRoute();
  route('user-profile.show', { user: 7 }, { tab: 'links' });
  route('auth.login');

  // Argument of type '"user-profile.shwo"' is not assignable to parameter of type
  // '"'user-profile.shwo' is not a route name — did you mean user-profile.show?"'.
  // @ts-expect-error
  route('user-profile.shwo', { user: 7 });
  // Property 'user' is missing in type '{}' but required in type '{ user: Param; }'.
  // @ts-expect-error
  route('user-profile.show', {});
  // Expected 2-3 arguments, but got 1.
  // @ts-expect-error
  route('user-profile.show');
  // Object literal may only specify known properties, and 'tab' does not exist in type '{ user: Param; }'.
  // @ts-expect-error — a query goes into the third argument
  route('user-profile.show', { user: 7, tab: 'links' });
  // ... '"'api.users.index' is not sent to the browser — API routes and clientRoutes.except stay on the server"'.
  // @ts-expect-error
  route('api.users.index');
  // @ts-expect-error — in clientRoutes.except (bootstrap/app.ts)
  route('auth.verification.verify', { id: 1, hash: 'x' });

  // E40: method, URL and fields from the route name.
  const form = useForm('user-profile.update', { user: 7 }, { name: '', bio: '' });
  void form.submit();
  // Argument of type '"bioo"' is not assignable to parameter of type '"bio" | "name"'.
  // @ts-expect-error
  form.set('bioo', '');
  // Object literal may only specify known properties, but 'bioo' does not exist in type '{ name: string; bio: string; }'.
  // Did you mean to write 'bio'?
  // @ts-expect-error
  useForm('user-profile.update', { user: 7 }, { name: '', bioo: '' });
  // Expected 3 arguments, but got 2.
  // @ts-expect-error — the route needs { user }
  useForm('user-profile.update', { name: '', bio: '' });
  // ... '"'auth.logout' has no request schema to type a form with — give its controller `static request = defineRequest(…)`"'.
  // @ts-expect-error
  useForm('auth.logout', {});
  // ... '"'user-profile.updte' is not a route name — did you mean user-profile.update?"'.
  // @ts-expect-error
  useForm('user-profile.updte', { user: 7 }, { name: '', bio: '' });
  // A route without parameters takes the initial data alone.
  useForm('auth.login.store', { email: '', password: '' });
  // The controller form stays: fields from the controller, any URL.
  void useForm<UpdateUserProfileController>({ name: '', bio: '' }).put('/users/7');

  return (
    <>
      <Link route="user-profile.show" params={{ user: 7 }} query={{ tab: 'links' }}>
        ok
      </Link>
      <Link route="auth.logout">a POST route renders a button</Link>
      <Link route="auth.logout" method="post">
        the method may be written out
      </Link>
      <Link href="https://example.com">any URL</Link>
      {/* Type '"user-profile.shwo"' is not assignable to type '"'user-profile.shwo' is not a route name — did you mean user-profile.show?"'. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.shwo" params={{ user: 7 }}>
        typo
      </Link>
      {/* Property 'params' is missing in type '{ route: "user-profile.show"; children: string; }' but required in type '{ params: { user: Param; }; }'. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.show">missing params</Link>
      {/* Object literal may only specify known properties, but 'usr' does not exist in type '{ user: Param; }'. Did you mean to write 'user'? */}
      {/* @ts-expect-error */}
      <Link route="user-profile.show" params={{ usr: 7 }}>
        wrong param
      </Link>
      {/* Type '"get"' is not assignable to type '"post"'. */}
      {/* @ts-expect-error */}
      <Link route="auth.logout" method="get">
        GET on a POST route
      </Link>
      {/* Type 'string' is not assignable to type 'undefined'. */}
      {/* @ts-expect-error — `route` or `href`, not both */}
      <Link route="auth.login" href="/login">
        both
      </Link>
    </>
  );
}

export class OnTheServer extends Controller {
  handle(router: Router, signer: UrlSigner) {
    router.url('user-profile.show', { user: 1 }, { tab: 'links' });
    // Argument of type '"user-profile.shwo"' is not assignable to parameter of type
    // '"'user-profile.shwo' is not a route name — did you mean user-profile.show?"'.
    // @ts-expect-error
    router.url('user-profile.shwo', { user: 1 });
    // ... '"'auth.lgin' is not a route name — did you mean auth.login, auth.logout?"'.
    // @ts-expect-error
    void this.redirect().route('auth.lgin');
    // Expected 2-3 arguments, but got 1.
    // @ts-expect-error
    void this.redirect().route('user-profile.show');
    // The server knows every route — API ones and `except` ones too.
    void this.redirect().route('api.users.index');
    signer.temporarySignedRoute('auth.verification.verify', { id: 1, hash: 'x' }, '60m');
    // Argument of type '{ id: number; }' is not assignable to parameter of type 'SignedParams<"auth.verification.verify">'.
    //   Property 'hash' is missing in type '{ id: number; }' but required in type '{ hash: Param; id: Param; }'.
    // @ts-expect-error
    signer.temporarySignedRoute('auth.verification.verify', { id: 1 }, '60m');
    // No overload matches this call. The last overload gave the following error.
    //   Type '"auth.lgin"' is not assignable to type '"'auth.lgin' is not a route name — did you mean auth.login, auth.logout?"'.
    // @ts-expect-error
    authenticate({ loginRoute: 'auth.lgin' });
    // Argument of type '"user-profile/Shwo"' is not assignable to parameter of type
    // '"'user-profile/Shwo' is not a view: there is no modules/user-profile/views/Shwo.tsx — did you mean user-profile/Show?"'.
    // @ts-expect-error
    void this.view('user-profile/Shwo', {});
    // ... '"'profile' is not a view — view names are '<module>/<Page>' (modules/<module>/views/<Page>.tsx)"'.
    // @ts-expect-error
    void view('profile', {});
    return this.view('user-profile/Show', {});
  }
}

export function InTests(response: TestResponse) {
  response.assertPage('user-profile/Show');
  // ... '"'user-profile/Shwo' is not a view: there is no modules/user-profile/views/Shwo.tsx — did you mean user-profile/Show?"'.
  // @ts-expect-error
  response.assertPage('user-profile/Shwo');
  // Argument of type '"user-profile/Edit"' is not assignable to parameter of type '"user-profile/Show"'.
  // @ts-expect-error — not the page this controller renders
  response.assertPage<ShowUserProfileController>('user-profile/Edit');
}
