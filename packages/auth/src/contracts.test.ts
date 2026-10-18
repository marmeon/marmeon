import { createApplication } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { AuthServiceProvider } from './index.ts';
import { DatabasePasswordResetTokens, PasswordResetTokenStore } from './password-reset.ts';
import { DatabaseSignIns, SignInStore } from './sign-ins.ts';
import { AccessTokenStore, DatabaseAccessTokens } from './tokens.ts';
import { NoTwoFactorState, TwoFactorState } from './two-factor/state.ts';

/**
 * The methods a base class implements itself, so that a store which does not override them still works — each with the reason why
 * none of the four criteria of a security-relevant member applies (docs/authentication.md#security-relevant-members). A method that
 * is added to a base class without an entry here fails this test, and the reviewer sees the classification in the diff.
 *
 * Every method of these classes is abstract today, so every list is empty.
 */
const DEFAULTS: Record<string, Record<string, string>> = {
  PasswordResetTokenStore: {},
  AccessTokenStore: {},
  SignInStore: {},
  TwoFactorState: {},
};

// Reflect.ownKeys sees symbol-keyed members too. A default can also be an instance field (`readonly x = async () => 0`): the instance of
// the abstract class has no own key at all, since the private mark is invisible to it.
const methodsOf = (base: abstract new () => object) => Reflect.ownKeys(base.prototype).filter((name) => name !== 'constructor');
const fieldsOf = (base: abstract new () => object) => Reflect.ownKeys(Reflect.construct(base as new () => object, []));

describe('the contracts of the auth stores', () => {
  it.each([
    ['PasswordResetTokenStore', PasswordResetTokenStore],
    ['AccessTokenStore', AccessTokenStore],
    ['SignInStore', SignInStore],
    ['TwoFactorState', TwoFactorState],
  ] as const)('%s has no method with a default that is not listed', (name, base) => {
    expect(methodsOf(base)).toEqual(Object.keys(DEFAULTS[name]!));
    expect(fieldsOf(base), 'only the private mark, which is no own key').toEqual([]);
  });

  it('are still the container keys: the class resolves to the database store', async () => {
    const app = await createApplication({ root: import.meta.dirname, discover: false, providers: [AuthServiceProvider] }, { env: {} });
    app.container.instance(Connections, {} as Connections); // the database provider is not part of this app
    expect(app.container.make(AccessTokenStore)).toBeInstanceOf(DatabaseAccessTokens);
    expect(app.container.make(PasswordResetTokenStore)).toBeInstanceOf(DatabasePasswordResetTokens);
    expect(app.container.make(SignInStore)).toBeInstanceOf(DatabaseSignIns);
    expect(app.container.make(TwoFactorState)).toBeInstanceOf(NoTwoFactorState);
  });
});
