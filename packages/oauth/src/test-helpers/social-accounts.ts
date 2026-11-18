import { TwoFactorState, type AuthUser, type AuthUserId, type SecondFactor } from '@marmeon/auth';
import { err, inTransaction, ok, type Result } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import type { Connections } from '@marmeon/database';
import { AesGcmEncrypter, generateKey } from '@marmeon/encryption';
import { SocialAccountStore } from '../accounts/store.ts';
import { SocialAccounts } from '../accounts/social-accounts.ts';
import type { SocialUserProvider } from '../accounts/users.ts';
import type { SocialUser } from '../definition.ts';
import { OAuthProviders, type ResolvedOAuthProvider } from '../registry.ts';
import { markVerified } from '../verified.ts';

/** The app's user in these tests: the row of `users` only holds the id, the rest lives here. */
export interface TestUser {
  readonly id: number;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly passwordHash: string | null;
}

/** The numeric id of a user `SocialAccounts` answered with (the user type is the app's; here it is a {@link TestUser}). */
export function idOf(user: AuthUser): number {
  return (user as unknown as TestUser).id;
}

/** A `SocialUser` the flow would have returned, marked for `intent`; `overrides` change the profile before it is marked. */
export function marked(intent: 'sign-in' | 'link', overrides: Partial<SocialUser> = {}, flowUserId?: string): SocialUser {
  const user: SocialUser = {
    provider: 'github',
    id: 'gh-1',
    email: 'ada@example.com',
    emailVerified: true,
    name: 'Ada',
    nickname: 'ada',
    avatar: null,
    raw: {},
    tokens: { accessToken: ['access', 'token'].join('-'), scopes: ['read:user'] },
    ...overrides,
  };
  markVerified(user, { intent, flowUserId });
  return user;
}

class FakeFactors extends TwoFactorState {
  readonly factorsOf = new Map<number, SecondFactor[]>();
  async factors(userId: AuthUserId): Promise<readonly SecondFactor[]> {
    return this.factorsOf.get(Number(userId)) ?? [];
  }
  async enabledSince(): Promise<Date | undefined> {
    return undefined;
  }
  async removeAll(): Promise<void> {}
}

/** A `TwoFactorState` nobody has a factor in, like the default the auth provider binds. */
export class UnboundFactors extends TwoFactorState {
  async factors(): Promise<readonly SecondFactor[]> {
    return [];
  }
  async enabledSince(): Promise<Date | undefined> {
    return undefined;
  }
  async removeAll(): Promise<void> {}
}

/** Ids of the users `create` makes: never reused, so a test that builds two worlds on one database does not collide. */
let nextUserId = 1000;

/** An active provider as the registry holds it; only its name and label are read. */
export function activeProvider(name: string, label = name): ResolvedOAuthProvider {
  return { name, label, definition: {} as never, credentials: { clientId: 'client', clientSecret: 'secret' } as never };
}

export interface WorldOptions {
  readonly registration?: boolean;
  readonly privateRegistration?: boolean;
  readonly active?: readonly string[];
  readonly factors?: TwoFactorState;
}

/**
 * Everything around `SocialAccounts` but the store, which is the real one on the database: a fake `Auth` (whom it signed in, whether
 * a confirmation is recent), a `UserProvider` and `SocialUserProvider` over a list of users, and an event list.
 */
export function world(connections: Connections, options: WorldOptions = {}) {
  const encrypter = new AesGcmEncrypter(Buffer.from(generateKey().replace('base64:', ''), 'base64'));
  const clock = new TestClock();
  const store = new SocialAccountStore(connections, clock, encrypter, { registration: true, storeTokens: false });
  const users = new Map<number, TestUser>();
  const factors = options.factors ?? new FakeFactors();
  const state = {
    signedIn: undefined as TestUser | undefined,
    /** Whose second factor a sign-in waits for. */
    pending: undefined as TestUser | undefined,
    confirmed: true,
    signIns: [] as TestUser[],
    events: [] as object[],
    /** What the store held when each event was dispatched: `find` for the account of the event. */
    heldAtEvent: [] as (boolean | undefined)[],
    /** Runs after `findByEmail` answered and before `create` runs: a parallel request. */
    afterLookup: undefined as (() => Promise<void>) | undefined,
    createCalls: 0,
    duplicate: false,
    boundSocialUsers: true,
    /** The bound provider cannot be built. */
    buildFails: false,
    /** `findByEmail` answers `null`, as a JavaScript provider might. */
    lookupNull: false,
    /** What `emailConfirmed` answers instead of the user's flag (a provider that answers loosely). */
    confirmedAnswer: undefined as unknown,
    /** Runs once `auth.signIn` has signed somebody in: a parallel request landing at that moment. */
    afterAuthSignIn: undefined as (() => Promise<void>) | undefined,
    /** Whether each dispatched event went out inside a transaction. */
    inTransaction: [] as boolean[],
    /** `findById` knows nobody. */
    noUsers: false,
  };
  const db = () => connections.get<any>();
  const add = async (user: Partial<TestUser> & { id: number }): Promise<TestUser> => {
    const full: TestUser = { email: `user${user.id}@example.com`, emailVerified: true, passwordHash: 'hash', ...user };
    await db().insertInto('users').values({ id: full.id }).execute();
    users.set(full.id, full);
    return full;
  };
  const auth = {
    check: async () => state.signedIn !== undefined,
    user: async () => state.signedIn,
    id: async () => state.signedIn?.id,
    passwordRecentlyConfirmed: () => state.confirmed,
    signOut: async () => {
      state.signedIn = undefined;
      state.pending = undefined;
    },
    signIn: async (user: TestUser) => {
      state.signIns.push(user);
      const second = (await factors.factors(user.id as AuthUserId)).length > 0;
      if (!second) state.signedIn = user;
      else state.pending = user;
      await state.afterAuthSignIn?.();
      return second ? ('two-factor-required' as const) : ('signed-in' as const);
    },
  };
  const userProvider = {
    findById: async (id: number) => {
      const user = state.noUsers ? undefined : users.get(Number(id));
      return user === undefined ? undefined : { user, passwordHash: user.passwordHash, sessionKey: null };
    },
  };
  const socialUsers: SocialUserProvider<TestUser> = {
    findByEmail: async (email) => {
      const found = [...users.values()].find((user) => user.email === email);
      const answer = found === undefined ? undefined : { user: found, emailVerified: found.emailVerified };
      await state.afterLookup?.();
      return state.lookupNull ? (null as never) : answer;
    },
    emailConfirmed: async (user) => (state.confirmedAnswer !== undefined ? (state.confirmedAnswer as boolean) : user.emailVerified),
    create: async (social, { emailVerified }): Promise<Result<TestUser, { readonly kind: 'duplicate' }>> => {
      state.createCalls += 1;
      if (state.duplicate) return err({ kind: 'duplicate' });
      return ok(await add({ id: nextUserId++, email: social.email, emailVerified, passwordHash: null }));
    },
  };
  const dispatcher = {
    dispatch: async (event: { provider?: string; user?: TestUser }) => {
      state.events.push(event);
      state.inTransaction.push(inTransaction());
      const owner = event.user === undefined ? undefined : await store.forUser(event.user.id as AuthUserId);
      state.heldAtEvent.push(owner?.some((record) => record.provider === event.provider));
    },
  };
  const socialUsersOf = () => {
    if (state.buildFails) throw new Error('UserRepository needs a table');
    return state.boundSocialUsers ? socialUsers : undefined;
  };
  const providers = new OAuthProviders((options.active ?? []).map((name) => activeProvider(name, name.toUpperCase())));
  const accounts = new SocialAccounts(
    auth as never,
    userProvider as never,
    factors,
    store,
    providers,
    { registration: options.registration ?? true, storeTokens: false },
    { privateRegistration: options.privateRegistration ?? true } as never,
    connections,
    dispatcher as never,
    socialUsersOf as never,
  );
  return {
    accounts,
    store,
    clock,
    state,
    add,
    factors: factors as FakeFactors,
    userCount: async () => (await db().selectFrom('users').select('id').execute()).length,
    signInAs: (user: TestUser) => {
      state.signedIn = user;
    },
  };
}

export type World = ReturnType<typeof world>;
export type { AuthUser };
