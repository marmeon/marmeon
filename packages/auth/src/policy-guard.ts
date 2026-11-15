import { withCode } from '@marmeon/core/internal';
import type { ClassResolver } from '@marmeon/router';
import { Guard, GuardRegistry, type GuardDefinition } from './define-guard.ts';
import { isGuardSlot, slotTarget, type GuardSlotBase } from './guard-slot.ts';
import type { AuthUser } from './user.ts';

/**
 * The users the guard definition or slot `G` judges: its user type, or the app's. `never` for anything else, so nothing compiles against a guard
 * the runtime would refuse. The union test is on the definitions, not on the user type: a guard may have users of two kinds, but a
 * variable that holds the policies of two guards has no one user type, and no ability fits both.
 */
type GuardUser<G> = [G] extends [undefined]
  ? AuthUser
  : [G] extends [UnionToIntersection<G>]
    ? [G] extends [GuardSlotBase<infer U>]
      ? U
      : [G] extends [GuardDefinition<infer U>]
        ? U
        : never
    : never;

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void ? I : never;

/**
 * Whom the policy class `C` judges, from its `static guard`: the guard's user, or the app's `AuthUser` without one. A policy method takes
 * this type after `can()` and the gate's methods are typed with it. The runtime reads the static itself, as TypeScript erases types.
 */
export type PolicyUser<C> = C extends unknown ? ('guard' extends keyof C ? GuardUser<C['guard' & keyof C]> : AuthUser) : never;

/** What each policy class said about its guard, read once: the static is inherited, so a subclass of a policy of a guard judges that guard's users. */
const STATICS = new WeakMap<object, unknown>();

/**
 * The guard a policy class judges users of: `undefined` for the app's, the registered guard its `static guard` names otherwise. A guard slot
 * counts as what it is bound to (`undefined` for `'web'`), looked up at every call, never remembered. Anything else (a name, a definition of
 * a guard nobody registered, a slot nobody bound) is error A8 at the first use, before any policy runs: a policy that cannot say whose users
 * it judges must not be asked about anybody's.
 */
export function policyGuard(policy: object, resolve: ClassResolver): Guard | undefined {
  if (!STATICS.has(policy)) STATICS.set(policy, (policy as { guard?: unknown }).guard);
  const named = STATICS.get(policy);
  if (named === undefined) return undefined;
  if (isGuardSlot(named)) {
    const target = slotTarget(named, resolve);
    return target === 'web' ? undefined : target;
  }
  if (named instanceof Guard && resolve(GuardRegistry).all().includes(named)) return named;
  const name = (policy as { name?: unknown }).name;
  throw new TypeError(
    withCode('A8', `${typeof name === 'string' && name !== '' ? name : 'A policy'} names a guard that is not one registered in this app: static guard is the definition made by defineGuard(), registered by its package, or a slot made by defineGuardSlot().`),
  );
}
