/**
 * Type guarantees of the abilities projection against this app's policies — checked by `tsc` (`pnpm typecheck`,
 * `marmeon build`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the comment above it is the
 * message they get (read with the directive removed).
 */
import { Gate, type Projection } from '@marmeon/auth';
import { Controller, type PageProps } from '@marmeon/http';
import { expectTypeOf } from 'vitest';
import { DashboardPolicy } from '../dashboard/policies/DashboardPolicy.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { ProfileLinkPolicy } from './policies/ProfileLinkPolicy.ts';
import { ProfilePolicy } from './policies/ProfilePolicy.ts';

declare const gate: Gate;
const profile = { id: 1, name: 'Ada' };
const links = [{ id: 1, user_id: 1, label: 'Notes', url: 'https://example.com' }];

export async function Projections() {
  // One boolean per named ability — typed by the names, lazy until asked for (or awaited).
  expectTypeOf(gate.abilities(profile, ProfilePolicy, ['update', 'viewEmail'])).toEqualTypeOf<Projection<{ update: boolean; viewEmail: boolean }>>();
  expectTypeOf(await gate.abilities(profile, ProfilePolicy, ['update'])).toEqualTypeOf<{ update: boolean }>();
  // Abilities without a resource: no resource argument.
  expectTypeOf(await gate.abilities(DashboardPolicy, ['viewMembers'])).toEqualTypeOf<{ viewMembers: boolean }>();
  // Rows keep their columns and gain `can`.
  const rows = await gate.withAbilities(links, ProfileLinkPolicy, ['delete']);
  expectTypeOf(rows).toEqualTypeOf<{ id: number; user_id: number; label: string; url: string; can: { delete: boolean } }[]>();

  // Type '"updte"' is not assignable to type '"'updte' is not an ability of this policy — it has update, viewEmail"'.
  // @ts-expect-error
  void gate.abilities(profile, ProfilePolicy, ['updte']);
  // `before` is a hook, not an ability: Type '"before"' is not assignable to type '"'before' is not an ability of this
  // policy — it has delete"'.
  // @ts-expect-error
  void gate.withAbilities(links, ProfileLinkPolicy, ['before']);

  // The resource is checked against the policy method's parameter:
  // Property 'id' is missing in type '{ name: string; }' but required in type '{ readonly id: number; }'.
  const stranger = { name: 'Ada' };
  // @ts-expect-error
  void gate.abilities(stranger, ProfilePolicy, ['update']);
  // Rows without what the policy reads (links of a query that left out `user_id`):
  // Argument of type '{ id: number; label: string; }[]' is not assignable to parameter of type 'readonly OwnedLink[]'.
  //   Property 'user_id' is missing in type '{ id: number; label: string; }' but required in type 'OwnedLink'.
  const unowned = [{ id: 1, label: 'Notes' }];
  // @ts-expect-error
  void gate.withAbilities(unowned, ProfileLinkPolicy, ['delete']);
  // An ability that needs its resource, asked without one:
  // Type '"update"' is not assignable to type '"'update' needs its resource — gate.abilities(resource, Policy, ['update'])"'.
  // @ts-expect-error
  void gate.abilities(ProfilePolicy, ['update']);
  // With a resource, abilities that take none may be asked alongside (the resource is not passed to them).
  expectTypeOf(await gate.abilities(profile, DashboardPolicy, ['viewMembers'])).toEqualTypeOf<{ viewMembers: boolean }>();
}

/** Nested in a prop, a projection has to be awaited — a function inside an object never reaches the browser. */
export class Forgotten extends Controller {
  handle() {
    return this.view('user-profile/Show', { profile: { ...profile, can: gate.abilities(profile, ProfilePolicy, ['update']) } });
  }
}

export function Views(props: PageProps<ShowUserProfileController>, forgotten: PageProps<Forgotten>) {
  // In the view: plain booleans — no framework `can()` in the browser.
  expectTypeOf(props.abilities).toEqualTypeOf<{ update: boolean }>();
  expectTypeOf(props.profile.links[0]!.can).toEqualTypeOf<{ delete: boolean }>();
  // Property 'delete' does not exist on type '{ update: boolean; }'.
  // @ts-expect-error
  void props.abilities.delete;
  // The forgotten `await`: the function is dropped on the way (Serialize), so the view cannot read it —
  // Property 'can' does not exist on type '{ readonly id: number; readonly name: string; }'.
  // @ts-expect-error
  void forgotten.profile.can;
}
