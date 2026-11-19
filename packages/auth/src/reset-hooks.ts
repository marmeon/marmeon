import type { Container } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import type { AuthUserId } from './user.ts';

/**
 * What a package that holds a first factor of its own (a linked provider account, say) must do when the password of an account is
 * reset. It runs inside the transaction of the reset, after the new password is written: whatever it throws rolls the reset back, so a
 * reset never stands next to a way in the owner did not have. `emailConfirmed` is whether the account's address is confirmed
 * (`email_verified_at` set); an account that does not say counts as unconfirmed.
 *
 * @internal
 */
export type PasswordResetHook = (input: { readonly userId: AuthUserId; readonly emailConfirmed: boolean }) => Promise<void>;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The hooks claimed on a root container, by name, and whether the auth provider has booted (no claim after that). */
const registry = new WeakMap<object, { readonly hooks: Map<string, PasswordResetHook>; sealed: boolean }>();

const entryOf = (root: object) => {
  let found = registry.get(root);
  if (found === undefined) {
    found = { hooks: new Map(), sealed: false };
    registry.set(root, found);
  }
  return found;
};

/**
 * Ends the claims on `root`, as the auth provider's boot does: a hook claimed afterwards throws.
 *
 * @internal
 */
export function sealPasswordResetHooks(root: object): void {
  entryOf(root).sealed = true;
}

/**
 * Registers `hook` under `name` for the app's guard, once per name and root container and before the auth provider boots. The reset of
 * the app guard's users runs it in its transaction. A name of another form, a second claim, a claim on a request's scope and a claim
 * after the boot throw (code A12).
 *
 * @internal
 */
export function onPasswordReset(container: Container, name: string, hook: PasswordResetHook): void {
  if (!NAME.test(name)) throw new Error(withCode('A12', `A password reset hook name is lower case letters, digits and hyphens, starting with a letter, at most 32 long: got ${JSON.stringify(name)}.`));
  if (container.isScope) throw new Error(withCode('A12', `The password reset hook "${name}" is claimed on a request's scope: claim it on the app's container, in a provider's register().`));
  if (typeof hook !== 'function') throw new TypeError(withCode('A12', `The password reset hook "${name}" must be a function.`));
  const entry = entryOf(container);
  if (entry.sealed) throw new Error(withCode('A12', `The password reset hook "${name}" is claimed after the auth provider booted: claim it in a provider's register().`));
  if (entry.hooks.has(name)) throw new Error(withCode('A12', `The password reset hook "${name}" is claimed already.`));
  entry.hooks.set(name, hook);
}

/**
 * The hooks of `root`, in the order they were claimed; none for a guard that has no root (a package guard).
 *
 * @internal
 */
export function passwordResetHooks(root: object | undefined): readonly PasswordResetHook[] {
  const entry = root === undefined ? undefined : registry.get(root);
  return entry === undefined ? [] : [...entry.hooks.values()];
}
