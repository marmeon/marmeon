/**
 * Type guarantees of layers (E53) against this app's routes — checked by `tsc` (`pnpm typecheck`, `bespoke build`), never
 * run. Each `@ts-expect-error` is a mistake an app developer makes; the comment above it is the message they get (read with
 * the directive removed).
 */
import { Controller, type PageProps } from '@bespokecore/http';
import { Link, useLayer } from '@bespokecore/react';
import { expectTypeOf } from 'vitest';
import type { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

export function Links() {
  return (
    <>
      <Link route="user-profile.edit" params={{ user: 1 }} layer>
        Edit
      </Link>
      {/* Without `layer` it is a visit — whose answer, a layer, still opens over the page. */}
      <Link route="user-profile.edit" params={{ user: 1 }}>
        Edit
      </Link>
      {/* Type 'true' is not assignable to type '"'user-profile.show' does not open a layer — its controller returns this.view(…)
          without .layer({ base }); drop `layer` to visit it as a page"'. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.show" params={{ user: 1 }} layer>
        Profile
      </Link>
      {/* Type 'true' is not assignable to type '"'dashboard.sign-ins' is an island, not a layer — embed it with
          <Island route=\"dashboard.sign-ins\">"'. (And the route itself: '… is an island, not a page — …'.) */}
      {/* @ts-expect-error */}
      <Link route="dashboard.sign-ins" layer>
        Sign-ins
      </Link>
    </>
  );
}

export class Layers extends Controller {
  handle() {
    // Type '"user-profile.shwo"' is not assignable to type '"'user-profile.shwo' is not a route name — did you mean user-profile.show?"'.
    // @ts-expect-error
    void this.view('user-profile/Edit', {}).layer({ base: 'user-profile.shwo', params: { user: 1 } });
    // Type '"dashboard.sign-ins"' is not assignable to type '"'dashboard.sign-ins' is an island — a layer's base is a page (or
    // another layer) that a deep link shows under it"'.
    // @ts-expect-error
    void this.view('user-profile/Edit', {}).layer({ base: 'dashboard.sign-ins' });
    // Type '"user-profile.update"' is not assignable to type '"'user-profile.update' is a PUT route — a layer's base is a page: a
    // GET route that answers this.view(…)"'.
    // @ts-expect-error
    void this.view('user-profile/Edit', {}).layer({ base: 'user-profile.update', params: { user: 1 } });
    // Argument of type '{ base: "user-profile.show"; }' is not assignable to parameter of type 'LayerOptions<"user-profile.show">'.
    //   Property 'params' is missing in type '{ base: "user-profile.show"; }' but required in type '{ params: { user: Param; }; }'.
    // @ts-expect-error
    void this.view('user-profile/Edit', {}).layer({ base: 'user-profile.show' });
    // Type '"nme"' is not assignable to type '"-joined" | "-name" | "joined" | "name" | undefined'. Did you mean '"name"'?
    // @ts-expect-error
    void this.view('user-profile/Edit', {}).layer({ base: 'user-profile.people', query: { sort: 'nme' } });
    void this.view('user-profile/Edit', {}).layer({ base: 'user-profile.people', query: { sort: 'name' } });
    return this.view('user-profile/Edit', {}).layer({ base: 'user-profile.show', params: { user: 1 }, key: 'profile.edit' });
  }
}

export function Views(props: PageProps<EditUserProfileController>) {
  // A layer's props are a page's: `PageProps<C>` (the shared ones included).
  expectTypeOf(props.profile.links).toEqualTypeOf<{ id: number; user_id: number; label: string; url: string; can: { delete: boolean } }[]>();
  const layer = useLayer<EditUserProfileController>();
  expectTypeOf(layer.depth).toEqualTypeOf<number>();
  expectTypeOf(layer.isLayer).toEqualTypeOf<boolean>();
  // Type 'ShowUserProfileController' does not satisfy the constraint '{ handle: "this controller never answers a layer —
  // useLayer<C>() is for the view of a layer: its controller returns this.view(…).layer({ base })"; }'.
  // @ts-expect-error
  useLayer<ShowUserProfileController>();
  // Without a controller: any view may ask (a view that is a page and a layer reads `isLayer`).
  useLayer();
  return null;
}
