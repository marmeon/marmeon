import { CacheServiceProvider } from '@marmeon/cache';
import { createApplication } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { ClientHistory, HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { AuthServiceProvider } from './index.ts';
import type { Container } from '@marmeon/core';
import type { Session } from '@marmeon/session';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as publicApi from './index.ts';
import { AppGuardContext } from './app-guard-context.ts';
import { Auth } from './auth.ts';
import { AUTH_SESSION_KEYS } from './session-keys.ts';
import { SessionFingerprints } from './fingerprint.ts';
import type { Hasher } from './hashing.ts';
import { CONFIRM_REAUTHENTICATED, reauthenticator, sealReauthentication, type ReauthenticationProof } from './reauthentication.ts';
import { NO_CLIENT } from './test-helpers/client.ts';
import { guardNames } from './guard-names.ts';
import { guardContext } from './test-helpers/guard-context.ts';
import { NO_LOGIN_LIMITS } from './test-helpers/login-limits.ts';
import { signInStore } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { NoTwoFactorState } from './two-factor/state.ts';
import { newRequestGuard } from './request-guard.ts';
import type { UserProvider } from './user.ts';

const ada = { id: 1, name: 'Ada', email: 'ada@example.com' };
const bob = { id: 2, name: 'Bob', email: 'bob@example.com' };

/** A session that keeps its data in a map and notes, with the data at that moment, every id it renewed. */
class FakeSession {
  started = true;
  readOnly = false;
  id = 'id-0';
  readonly data = new Map<string, unknown>();
  readonly renewals: Array<{ id: string; confirmedAt: unknown }> = [];
  get(key: string): unknown {
    return this.data.get(key);
  }
  put(key: string, value: unknown): void {
    this.data.set(key, value);
  }
  has(key: string): boolean {
    return this.data.has(key);
  }
  forget(...keys: string[]): void {
    for (const key of keys) this.data.delete(key);
  }
  #renewed = 0;
  regenerate(): void {
    this.id = `id-${++this.#renewed}`;
    this.renewals.push({ id: this.id, confirmedAt: this.data.get(AUTH_SESSION_KEYS.confirmedAt) });
  }
  invalidate(): void {}
}

/** A root container as far as claiming a capability looks at it. */
const rootContainer = (clock: () => unknown, isScope = false) => ({ isScope, make: () => clock() }) as unknown as Container;

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

async function boot(options: { guard?: string; signedIn?: boolean; claimedWith?: unknown; seal?: boolean } = {}) {
  const { guard, signedIn = true, seal = true } = options;
  const now = { value: T0 };
  const clock = { now: () => now.value } as never;
  let current: unknown = options.claimedWith ?? clock;
  const container = rootContainer(() => current);
  const users = new MemoryUsers();
  users.add(ada);
  users.add(bob);
  const session = new FakeSession();
  const hasher = { failureFloorMs: () => 0 } as unknown as Hasher;
  const auth = new Auth(
    guardContext({ root: container, settings: { passwordTimeoutSeconds: 900 }, ...(guard === undefined ? {} : { names: guardNames(guard) }), users: users as UserProvider, factors: new NoTwoFactorState(), signIns: signInStore(), fingerprints: new SessionFingerprints({ key: new Uint8Array(32), previousKeys: [] }), signInThrottle: NO_LOGIN_LIMITS }),
    session as unknown as Session,
    hasher,
    { dispatch: async () => {} } as never,
    { get: () => undefined, set() {}, delete() {} } as never,
    {} as never,
    {} as never,
    new ClientHistory(),
    NO_CLIENT,
    clock,
    {} as never,
    newRequestGuard(),
  );
  const issuer = reauthenticator(container, 'oauth');
  current = clock; // what the app binds after the claim (a test clock)
  if (seal) sealReauthentication(container); // the auth provider has booted
  if (signedIn) await auth.signIn(ada);
  session.renewals.length = 0;
  const confirmedAt = () => session.data.get(AUTH_SESSION_KEYS.confirmedAt);
  const signedInAt = session.data.get(AUTH_SESSION_KEYS.signedInAt) as number;
  return { auth, session, issuer, now, container, clock, users, confirmedAt, signedInAt, take: (proof: ReauthenticationProof) => auth[CONFIRM_REAUTHENTICATED](proof) };
}

const wrote = (session: FakeSession) => session.renewals.length;

describe('opening the confirmation window from a verified re-authentication', () => {
  it('opens the window for a proof from the issuer', async () => {
    const { issuer, take, session, confirmedAt } = await boot();
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(true);
    expect(confirmedAt()).toBe(T0 / 1000);
    expect(wrote(session)).toBe(1);
  });

  it('a clock bound after the claim is the one that stamps the proof', async () => {
    const { issuer, take } = await boot({ claimedWith: { now: () => 0 } });
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(true);
  });

  it('a proof on a root the auth provider has not booted opens nothing', async () => {
    const { issuer, take, container, session } = await boot({ seal: false });
    expect(container).toBeDefined();
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(false);
    expect(wrote(session)).toBe(0);
  });

  it('a plain object with the fields of a proof opens nothing', async () => {
    const { take, session, confirmedAt } = await boot();
    const before = confirmedAt();
    expect(await take({ userId: '1', authenticatedAt: new Date(T0), issuedAt: T0, via: 'oauth' } as ReauthenticationProof)).toBe(false);
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
  });

  it('a copy of an issued proof opens nothing', async () => {
    const { issuer, take, confirmedAt } = await boot();
    const before = confirmedAt();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    expect(await take({ ...proof })).toBe(false);
    expect(confirmedAt()).toBe(before);
  });

  it('a proof works once', async () => {
    const { issuer, take, session } = await boot();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    expect(await take(proof)).toBe(true);
    expect(await take(proof)).toBe(false);
    expect(wrote(session)).toBe(1);
  });

  it('a refused proof is spent too', async () => {
    const { issuer, take, session } = await boot();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    session.readOnly = true;
    expect(await take(proof)).toBe(false);
    session.readOnly = false; // the reason is gone: the same proof is still no proof
    expect(await take(proof)).toBe(false);
    expect(wrote(session)).toBe(0);
  });

  it('two takes at once open the window once', async () => {
    const { issuer, take, session } = await boot();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    expect(await Promise.all([take(proof), take(proof)])).toEqual([true, false]);
    expect(wrote(session)).toBe(1);
  });

  it('changing the proof after it was issued changes nothing', async () => {
    const { issuer, take, signedInAt, session, confirmedAt } = await boot();
    const before = confirmedAt();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date((signedInAt - 100) * 1000) }) as unknown as { authenticatedAt?: Date; userId?: string; issuedAt?: number };
    for (const field of ['authenticatedAt', 'userId', 'issuedAt'] as const) {
      try {
        Reflect.set(proof, field, field === 'authenticatedAt' ? new Date(T0) : field === 'userId' ? '1' : T0);
      } catch {
        // a frozen object refuses
      }
    }
    expect(Reflect.set(proof, 'via', 'other')).toBe(false);
    proof.authenticatedAt?.setTime(T0);
    expect(await take(proof as ReauthenticationProof)).toBe(false); // the record still says: before this sign-in
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
  });

  it('a proof of exactly 60 seconds opens the window, one of 60 seconds and a millisecond does not', async () => {
    const edge = await boot();
    const ok = edge.issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    edge.now.value = T0 + 60_000;
    expect(await edge.take(ok)).toBe(true);
    const late = await boot();
    const proof = late.issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    late.now.value = T0 + 60_001;
    expect(await late.take(proof)).toBe(false);
  });

  it('a proof older than 60 seconds opens nothing', async () => {
    const { issuer, take, now, confirmedAt, session } = await boot();
    const before = confirmedAt();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    now.value = T0 + 60_001;
    expect(await take(proof)).toBe(false);
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
  });

  it('a proof for another user opens nothing', async () => {
    const { issuer, take, confirmedAt, session } = await boot();
    const before = confirmedAt();
    expect(await take(issuer.issue({ userId: 2, authenticatedAt: new Date(T0) }))).toBe(false);
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
  });

  it('an authentication before this sign-in began opens nothing', async () => {
    const { issuer, take, confirmedAt, session, signedInAt } = await boot();
    const before = confirmedAt();
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date((signedInAt - 1) * 1000) }))).toBe(false);
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
  });

  it('an authentication in the future beyond the clock skew opens nothing', async () => {
    const { issuer, take, confirmedAt, session } = await boot();
    const before = confirmedAt();
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0 + 61_000) }))).toBe(false);
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0 + 60_000) }))).toBe(true);
  });

  it("opens the window for the proof's time, not for now", async () => {
    const { issuer, take, now, confirmedAt } = await boot();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date(T0 + 5_000) });
    now.value = T0 + 30_000;
    expect(await take(proof)).toBe(true);
    expect(confirmedAt()).toBe(T0 / 1000 + 5);
  });

  it('renews the session id before the window opens', async () => {
    const { issuer, take, session, confirmedAt } = await boot();
    const old = session.id;
    const before = confirmedAt();
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0 + 5_000) }))).toBe(true);
    expect(session.id).not.toBe(old);
    expect(session.renewals).toEqual([{ id: session.id, confirmedAt: before }]); // not yet written when the id changed
    expect(confirmedAt()).toBe(T0 / 1000 + 5);
  });

  it('a read-only session opens nothing', async () => {
    const { issuer, take, session, confirmedAt } = await boot();
    const before = confirmedAt();
    session.readOnly = true;
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(false);
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
  });

  it('a session that did not start opens nothing', async () => {
    const { issuer, take, session } = await boot();
    session.started = false;
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(false);
    expect(wrote(session)).toBe(0);
  });

  it("a package guard's Auth opens nothing", async () => {
    const { issuer, take, session } = await boot({ guard: 'office' });
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(false);
    expect(wrote(session)).toBe(0);
  });

  it('a proof from the clock of the future (negative age) or of no time opens nothing', async () => {
    const { issuer, take, now, session, confirmedAt } = await boot();
    const before = confirmedAt();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    now.value = T0 - 1;
    expect(await take(proof)).toBe(false);
    now.value = Number.NaN;
    const unknown = issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    now.value = T0;
    expect(await take(unknown)).toBe(false);
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
  });

  it('an authentication older than the confirmation timeout opens nothing', async () => {
    const { issuer, take, now, session, confirmedAt } = await boot();
    const before = confirmedAt();
    now.value = T0 + 3_600_000;
    // the proof is fresh, what it vouches for is not: the sign-in is older, but the time is inside it
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0 + 1000) }))).toBe(false);
    expect(confirmedAt()).toBe(before);
    expect(wrote(session)).toBe(0);
  });

  it('an authentication not later than the confirmation held opens nothing and keeps the window', async () => {
    const { issuer, take, session, confirmedAt } = await boot();
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0 + 5_000) }))).toBe(true);
    session.renewals.length = 0;
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0 + 3_000) }))).toBe(false);
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0 + 5_000) }))).toBe(false);
    expect(confirmedAt()).toBe(T0 / 1000 + 5);
    expect(wrote(session)).toBe(0);
  });

  it('after taking, the window is open and no password counts as typed', async () => {
    const { auth, issuer, take, session } = await boot();
    expect(auth.passwordRecentlyConfirmed(60)).toBe(false);
    const typed = session.data.get(AUTH_SESSION_KEYS.typedPassword);
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(true);
    expect(auth.passwordRecentlyConfirmed(60)).toBe(true);
    expect(session.data.get(AUTH_SESSION_KEYS.typedPassword)).toBe(typed);
  });

  it('nobody signed in opens nothing', async () => {
    const { issuer, take, session } = await boot({ signedIn: false });
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(false);
    expect(wrote(session)).toBe(0);
    expect(session.data.has(AUTH_SESSION_KEYS.confirmedAt)).toBe(false);
  });

  it('signing out between issuing and taking opens nothing', async () => {
    const { auth, issuer, take, session } = await boot();
    const proof = issuer.issue({ userId: 1, authenticatedAt: new Date(T0) });
    await auth.signOut();
    session.renewals.length = 0;
    expect(await take(proof)).toBe(false);
    expect(wrote(session)).toBe(0);
    expect(session.data.has(AUTH_SESSION_KEYS.confirmedAt)).toBe(false);
  });

  it('a sign-in waiting for its second factor opens nothing', async () => {
    const { issuer, take, session } = await boot({ signedIn: false });
    session.put(AUTH_SESSION_KEYS.pending, { userId: 1, typedAt: T0 / 1000, failures: 0 });
    expect(await take(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(false);
    expect(wrote(session)).toBe(0);
    expect(session.data.has(AUTH_SESSION_KEYS.confirmedAt)).toBe(false);
  });

  it("a proof from another container opens nothing in this one's guard", async () => {
    const mine = await boot();
    const other = await boot();
    const before = mine.confirmedAt();
    expect(await mine.take(other.issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(false);
    expect(mine.confirmedAt()).toBe(before);
    expect(wrote(mine.session)).toBe(0);
  });

  it('a guard that was built without a root takes no proof', async () => {
    const { issuer, session } = await boot();
    const bare = new Auth(guardContext({ users: new MemoryUsers() as UserProvider }), session as unknown as Session, {} as never, {} as never, {} as never, {} as never, {} as never, new ClientHistory(), NO_CLIENT, {} as never, {} as never, newRequestGuard());
    expect(await bare[CONFIRM_REAUTHENTICATED](issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(false);
  });

  it('the app guard asks for proofs claimed on the container it was built for', async () => {
    const { container } = await boot();
    expect(new AppGuardContext(container as never, container).reauthenticationRoot()).toBe(container);
  });

  it('the auth provider ends the claims when it boots', async () => {
    const application = await createApplication(
      { root: workspaceTempDir('marmeon-reauthentication-'), discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider] },
      { env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1', CACHE_DRIVER: 'memory' } },
    );
    expect(() => reauthenticator(application.container, 'late')).toThrow(/A12/);
  });

  it('a claim after the auth provider booted stops with A12', async () => {
    const { container } = await boot();
    sealReauthentication(container);
    expect(() => reauthenticator(container, 'late')).toThrow(/A12/);
  });

  it("a claim on a request's scope stops with A12", async () => {
    const { clock } = await boot();
    expect(() => reauthenticator(rootContainer(() => clock, true), 'oauth')).toThrow(/A12/);
  });

  it('another container can claim the same name, and a name of 32 characters or with a hyphen is fine', async () => {
    const { clock } = await boot();
    const second = rootContainer(() => clock);
    expect(() => reauthenticator(second, 'oauth')).not.toThrow();
    expect(() => reauthenticator(second, `a${'b'.repeat(31)}`)).not.toThrow();
    expect(() => reauthenticator(second, 'social-login-2')).not.toThrow();
  });

  it('a second claim of a name stops with A12', async () => {
    const { container } = await boot();
    expect(() => reauthenticator(container, 'oauth')).toThrow(/A12/);
  });

  it('a name outside lower case letters, digits and hyphens stops with A12', async () => {
    const { container } = await boot();
    for (const name of ['', 'Oauth', '1oauth', 'oauth_x', 'a'.repeat(33)]) expect(() => reauthenticator(container, name)).toThrow(/A12/);
  });

  it('the issued proof is frozen', async () => {
    const { issuer } = await boot();
    expect(Object.isFrozen(issuer.issue({ userId: 1, authenticatedAt: new Date(T0) }))).toBe(true);
  });

  it('the main entry exports no way to claim or take a proof', () => {
    expectTypeOf(publicApi).not.toHaveProperty('CONFIRM_REAUTHENTICATED');
    expectTypeOf(publicApi).not.toHaveProperty('reauthenticator');
  });
});
