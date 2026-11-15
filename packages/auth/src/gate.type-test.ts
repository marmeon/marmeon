// Type guarantees of a policy that names its guard — checked by `tsc` (typecheck), never run.
import { expectTypeOf } from 'vitest';
import { defineGuard } from './define-guard.ts';
import { authenticate, can, Gate, type AbilityOf, type PolicyClass, type PolicyUser } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import type { AuthUser, Credentials, UserProvider } from './user.ts';

interface OfficeUser {
  readonly id: string;
  readonly name: string;
}
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

interface Editor {
  readonly id: string;
  readonly role: 'editor';
}
interface Admin {
  readonly id: string;
  readonly role: 'admin';
}
declare class StaffUsers implements UserProvider<Editor | Admin> {
  findById(id: string): Promise<Credentials<Editor | Admin> | undefined>;
  findForSignIn(identifier: string): Promise<Credentials<Editor | Admin> | undefined>;
  updatePasswordHash(id: string, hash: never, options?: { readonly expected?: never; readonly sessionKey?: string; readonly expectedSessionKey?: string | null }): Promise<boolean>;
  updateSessionKey(id: string, key: string, expected: string | null | undefined): Promise<boolean>;
  updateEverySessionKey(key: string): Promise<{ readonly accounts: number; readonly sampleId: string | undefined }>;
}
// One guard whose users are of two kinds: its policies judge the union.
const StaffGuard = defineGuard('staff', { users: StaffUsers, tablePrefix: 'staff_' });

class StaffPolicy {
  static readonly guard = StaffGuard;
  edit(user: Editor | Admin, page: Page) {
    return user.id === String(page.id);
  }
}

interface Page {
  readonly id: number;
}

class PagePolicy {
  static readonly guard = OfficeGuard;
  edit(user: OfficeUser, page: Page) {
    return user.name !== '' && page.id > 0;
  }
  create(user: OfficeUser) {
    return user.name !== '';
  }
  before(_user: OfficeUser) {
    return undefined;
  }
}

class ShopPolicy {
  static readonly guard = ShopGuard;
  edit(user: ShopUser, page: Page) {
    return user.region !== '' && page.id > 0;
  }
}

class AppPagePolicy {
  edit(user: AuthUser, page: Page) {
    return user.id === page.id;
  }
}

/** A subclass of a policy of a guard judges that guard's users: the static is inherited. */
class SeniorPagePolicy extends PagePolicy {
  publish(user: OfficeUser, page: Page) {
    return this.edit(user, page);
  }
}

class WrongStatic {
  static readonly guard = 'office';
  edit(_user: OfficeUser) {
    return true;
  }
}

declare const gate: Gate;
declare const page: Page;
declare const office: OfficeUser;

export async function policiesOfAGuard() {
  expectTypeOf<PolicyUser<typeof PagePolicy>>().toEqualTypeOf<OfficeUser>();
  expectTypeOf<PolicyUser<typeof SeniorPagePolicy>>().toEqualTypeOf<OfficeUser>();
  expectTypeOf<PolicyUser<typeof AppPagePolicy>>().toEqualTypeOf<AuthUser>();
  expectTypeOf<AbilityOf<PagePolicy, OfficeUser>>().toEqualTypeOf<'edit' | 'create'>();
  // The app's user is not what a policy of the guard judges: none of its methods is an ability of the app's users.
  expectTypeOf<AbilityOf<PagePolicy>>().toEqualTypeOf<never>();

  await gate.allows(PagePolicy, 'edit', page);
  await gate.allows(PagePolicy, 'create');
  await gate.authorize(SeniorPagePolicy, 'publish', page);
  await gate.allows(AppPagePolicy, 'edit', page);
  void gate.abilities(PagePolicy, ['create']);
  void gate.abilities(page, PagePolicy, ['edit']);
  void gate.withAbilities([page], PagePolicy, ['edit']);
  // @ts-expect-error `edit` needs its page
  await gate.allows(PagePolicy, 'edit');
  // @ts-expect-error not an ability of the policy
  await gate.allows(PagePolicy, 'delete', page);
  // @ts-expect-error `before` is a hook
  await gate.allows(PagePolicy, 'before');
  // @ts-expect-error the policy of the guard has no ability that takes the app's user: the projection does not know `edit` without its page either
  void gate.abilities(PagePolicy, ['edit']);
  // @ts-expect-error `edit` is no ability of a policy of the app's users when it takes the guard's user
  await gate.allows<PagePolicy, 'edit'>(PagePolicy, 'edit', page);

  // @ts-expect-error a bound parameter of the wrong type: `page` is a Page, not an OfficeUser
  await gate.allows(PagePolicy, 'edit', office);
}

export async function aGuardWithUnionUsers() {
  expectTypeOf<PolicyUser<typeof StaffPolicy>>().toEqualTypeOf<Editor | Admin>();
  await gate.allows(StaffPolicy, 'edit', page);
  // Two definitions in one union stay without a user type.
  expectTypeOf<PolicyUser<{ readonly guard: typeof OfficeGuard | typeof ShopGuard }>>().toEqualTypeOf<never>();
}

export function theStaticDecides() {
  // An explicit third argument cannot name another user than the class has: the type comes from the class.
  // @ts-expect-error AppPagePolicy judges the app's users, so OfficeUser is not its user
  void gate.allows<AppPagePolicy, 'edit', PolicyClass<AppPagePolicy> & { guard: typeof OfficeGuard }>(AppPagePolicy, 'edit', page);
  // @ts-expect-error a policy of the guard is not a policy of the app's users, whatever the generics say
  void gate.allows<PagePolicy, 'edit', typeof AppPagePolicy>(PagePolicy, 'edit', page);

  // A variable that holds either class has no single user: its abilities are none.
  const either = Math.random() > 0.5 ? PagePolicy : AppPagePolicy;
  // @ts-expect-error one policy judges the guard's users, the other the app's: no ability fits both
  void gate.allows(either, 'edit', page);
  const two = Math.random() > 0.5 ? PagePolicy : ShopPolicy;
  // @ts-expect-error two guards: no ability fits both
  void gate.allows(two, 'edit', page);

  // A class held as `PolicyClass<…>` says nothing of its guard: the methods that need the guard's user are no abilities.
  const wide: PolicyClass<PagePolicy> = PagePolicy;
  // @ts-expect-error the type of `wide` does not tell whose users it judges
  void gate.allows(wide, 'edit', page);
  // A static that is not a guard definition is no guard: its methods have no user type.
  // @ts-expect-error `guard` is a name, not a guard
  void gate.allows(WrongStatic, 'edit');
}

export function canNeedsTheGuardsUser() {
  const OFFICE = { loginRoute: 'office.login' } as const;
  openRoutes((Route) => {
    const signedIn = Route.middleware(OfficeGuard.authenticate(OFFICE));
    signedIn.authorize(can(PagePolicy, 'create'));
    signedIn.authorize(can(PagePolicy, 'edit', () => page));
    Route.middleware(authenticate()).authorize(can(AppPagePolicy, 'edit', () => page));
    // @ts-expect-error a route of the app's users: ctx.user is no OfficeUser
    Route.middleware(authenticate()).authorize(can(PagePolicy, 'create'));
    // @ts-expect-error the resource as a function: the user still has to be the guard's
    Route.middleware(authenticate()).authorize(can(PagePolicy, 'edit', () => page));
    // @ts-expect-error the resource as a bound parameter
    Route.middleware(authenticate()).authorize(can(PagePolicy, 'edit', 'page'));
    // @ts-expect-error a route without a signed-in user at all
    Route.authorize(can(PagePolicy, 'create'));
    // @ts-expect-error a route of the guard's users: ctx.user is no user of the app
    signedIn.authorize(can(AppPagePolicy, 'edit', () => page));
  });
}
