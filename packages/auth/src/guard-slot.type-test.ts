// Type guarantees of a guard slot — checked by `tsc` (typecheck), never run.
import type { Container, Token } from '@marmeon/core';
import type { MiddlewareClass } from '@marmeon/router';
import { expectTypeOf } from 'vitest';
import { defineGuard, type GuardAuth } from './define-guard.ts';
import { defineGuardSlot } from './guard-slot.ts';
import { TwoFactor } from './two-factor/two-factor.ts';
import { can, Gate, type PolicyUser } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import type { Credentials, UserProvider } from './user.ts';

/** What the package needs of its users. */
interface EditorUser {
  readonly id: string;
  readonly name: string;
}
interface OfficeUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}
/** Has no `name`: not what the slot's users are. */
interface ShopUser {
  readonly id: string;
  readonly region: string;
}

declare class OfficeUsers implements UserProvider<OfficeUser> {
  findById(id: string): Promise<Credentials<OfficeUser> | undefined>;
  findForSignIn(identifier: string): Promise<Credentials<OfficeUser> | undefined>;
  updatePasswordHash(id: string, hash: never, options?: { readonly expected?: never; readonly sessionKey?: string; readonly expectedSessionKey?: string | null }): Promise<boolean>;
  updateSessionKey(id: string, key: string, expected: string | null | undefined): Promise<boolean>;
  updateEverySessionKey(key: string): Promise<{ readonly accounts: number; readonly sampleId: string | undefined }>;
}
declare class ShopUsers implements UserProvider<ShopUser> {
  findById(id: string): Promise<Credentials<ShopUser> | undefined>;
  findForSignIn(identifier: string): Promise<Credentials<ShopUser> | undefined>;
  updatePasswordHash(id: string, hash: never, options?: { readonly expected?: never; readonly sessionKey?: string; readonly expectedSessionKey?: string | null }): Promise<boolean>;
  updateSessionKey(id: string, key: string, expected: string | null | undefined): Promise<boolean>;
  updateEverySessionKey(key: string): Promise<{ readonly accounts: number; readonly sampleId: string | undefined }>;
}

const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_' });
const ShopGuard = defineGuard('shop', { users: ShopUsers, tablePrefix: 'shop_' });
const FactorGuard = defineGuard('factor', { users: OfficeUsers, tablePrefix: 'factor_', twoFactor: TwoFactor });
const EditorSlot = defineGuardSlot<EditorUser>('editor');
const StaffSlot = defineGuardSlot<EditorUser>('staff', { twoFactor: true });

interface Page {
  readonly id: string;
}

class PagePolicy {
  static readonly guard = EditorSlot;
  edit(user: EditorUser, page: Page) {
    return user.id === page.id;
  }
}

export function bindings(container: Container) {
  EditorSlot.bind(container, 'web');
  // A guard whose users have everything the slot needs, and more.
  EditorSlot.bind(container, OfficeGuard);
  // @ts-expect-error the guard's users lack `name`, which the slot's policies read
  EditorSlot.bind(container, ShopGuard);
  // @ts-expect-error a target is 'web' or a guard
  EditorSlot.bind(container, 'office');
  StaffSlot.bind(container, 'web');
  StaffSlot.bind(container, FactorGuard);
  // @ts-expect-error the slot offers two-factor middleware: a guard defined without `twoFactor` cannot be bound to it
  StaffSlot.bind(container, OfficeGuard);
}

export function twoFactorMiddleware() {
  expectTypeOf(StaffSlot.twoFactor({ setup: 'a', verify: 'b' })).toEqualTypeOf<MiddlewareClass<{ readonly user: EditorUser }, {}>>();
  expectTypeOf(StaffSlot.confirmedSecondFactor({ verify: 'b' })).toEqualTypeOf<MiddlewareClass<{ readonly user: EditorUser }, {}>>();
  // @ts-expect-error a slot made without `twoFactor: true` has no two-factor middleware
  EditorSlot.twoFactor({ setup: 'a', verify: 'b' });
  // @ts-expect-error nor a second-factor confirmation
  EditorSlot.confirmedSecondFactor({ verify: 'b' });
}

export async function slotTypes(gate: Gate) {
  expectTypeOf(EditorSlot.Auth).toEqualTypeOf<Token<GuardAuth<EditorUser>>>();
  expectTypeOf(EditorSlot.authenticate({ loginRoute: 'editor.login' })).toEqualTypeOf<MiddlewareClass<{}, { readonly user: EditorUser }>>();
  expectTypeOf(EditorSlot.confirmedPassword({ confirmRoute: 'editor.confirm' })).toEqualTypeOf<MiddlewareClass<{ readonly user: EditorUser }, {}>>();
  // The methods of a policy of the slot take the slot's user.
  expectTypeOf<PolicyUser<typeof PagePolicy>>().toEqualTypeOf<EditorUser>();
  await gate.allows(PagePolicy, 'edit', { id: 'a' });
  // @ts-expect-error the resource is the page
  await gate.allows(PagePolicy, 'edit', 1);
  // A static that holds two slots, or a slot and a guard, has no one user type: no ability fits.
  expectTypeOf<PolicyUser<{ readonly guard: typeof EditorSlot | typeof StaffSlot }>>().toEqualTypeOf<never>();
  expectTypeOf<PolicyUser<{ readonly guard: typeof EditorSlot | typeof OfficeGuard }>>().toEqualTypeOf<never>();
}

export const routes = openRoutes((Route) => {
  Route.middleware(EditorSlot.authenticate({ loginRoute: 'editor.login' })).authorize(can(PagePolicy, 'edit', () => ({ id: 'a' }))).get('/page', () => 'page');
  // @ts-expect-error a route of the slot's users: ctx.user is no editor without the slot's authenticate()
  Route.authorize(can(PagePolicy, 'edit', () => ({ id: 'a' }))).get('/open', () => 'page');
});

// @ts-expect-error `id` is what a slot's users have at least
defineGuardSlot<{ readonly name: string }>('nobody');
