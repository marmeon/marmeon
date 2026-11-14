import type { RateLimiter } from '@marmeon/cache';
import { Container, type EventDispatcher } from '@marmeon/core';
import type { ClientInfo } from '@marmeon/http';
import type { CookieJar } from '@marmeon/router';
import { Session, type SessionConfig } from '@marmeon/session';
import { MemorySessionStore, plainSessionCodec } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import type { Auth } from '../auth.ts';
import { APP_PASSKEY_STORE, AppGuardContext } from '../app-guard-context.ts';
import { APP_GUARD_NAMES, guardNames, type GuardNames } from '../guard-names.ts';
import { guardContext, type GuardParts } from '../test-helpers/guard-context.ts';
import { twoFactorState } from '../test-helpers/stores.ts';
import type { TwoFactorStore } from '../two-factor/store.ts';
import type { AuthUser } from '../user.ts';
import type { PasskeyConfig } from './config.ts';
import { Passkeys } from './passkeys.ts';
import { PasskeyStore } from './store.ts';

const ada = { id: 1, name: 'Ada', email: 'ada@example.com' } as AuthUser & { id: number };
const office = guardNames('office');

/** A `PasskeyStore` that answers `forUser()` and nothing else. */
const passkeyStore = (): PasskeyStore =>
  Object.assign(Object.create(PasskeyStore.prototype), {
    forUser: async () => [{ credentialId: 'AAAA', transports: [], suspendedAt: null }],
    findByCredentialId: async () => undefined,
  }) as PasskeyStore;

async function startedSession(): Promise<Session> {
  const session = new Session(new MemorySessionStore(), { lifetimeMinutes: 120 } as SessionConfig, plainSessionCodec);
  await session.start();
  return session;
}

function serviceFor(names: GuardNames, session: Session, limiter: RateLimiter, ...stores: [object?]): Passkeys {
  return serviceWith(names, session, limiter, {}, ...stores);
}

function serviceWith(names: GuardNames, session: Session, limiter: RateLimiter, parts: GuardParts, ...stores: [object?]): Passkeys {
  const store = stores.length === 0 ? passkeyStore() : stores[0];
  const context = guardContext({
    names,
    passkeyStore: store,
    totp: {} as TwoFactorStore,
    factors: twoFactorState(),
    users: {} as never,
    auth: { user: async () => ada } as unknown as Auth,
    accountSessions: {} as never,
    ...parts,
  });
  const config = { relyingParty: () => ({ rpId: 'example.com', origins: ['https://example.com'] }) } as PasskeyConfig;
  return new Passkeys(context, session, config, limiter, { ip: '203.0.113.9', userAgent: 'test' } as ClientInfo, {} as CookieJar, { secure: false } as SessionConfig);
}

describe('Passkeys for a guard', () => {
  it('opens its challenge under the key of its guard, so that no other guard\'s ceremony can take it', async () => {
    const session = await startedSession();
    expect((await serviceFor(office, session, {} as RateLimiter).confirmOptions()).ok).toBe(true);
    expect(session.has('_auth:office:webauthn')).toBe(true);
    expect(session.has('_auth_webauthn'), 'the app guard has no open challenge').toBe(false);

    const app = await startedSession();
    expect((await serviceFor(APP_GUARD_NAMES, app, {} as RateLimiter).confirmOptions()).ok).toBe(true);
    expect(app.has('_auth_webauthn')).toBe(true);
    expect(app.has('_auth:office:webauthn')).toBe(false);
  });

  it('counts a confirmation under the key of its guard', async () => {
    const keys: string[] = [];
    const limiter = { attempt: async (key: string) => (keys.push(key), true), clear: async () => {}, availableInSeconds: async () => 0 } as unknown as RateLimiter;
    await serviceFor(office, await startedSession(), limiter).confirm({} as never);
    expect(keys).toEqual(['guard:office|passkey-confirm:1']);
  });

  it('counts failed sign-ins per address, and spends a challenge, under the keys of its guard', async () => {
    const keys: string[] = [];
    const record = async (key: string) => (keys.push(key), true);
    const limiter = { attempt: record, tooManyAttempts: async (key: string) => (keys.push(key), false), hit: async (key: string) => void keys.push(key), clear: async () => {}, availableInSeconds: async () => 0 } as unknown as RateLimiter;
    const session = await startedSession();
    const service = serviceFor(office, session, limiter);
    await service.signIn({} as never);
    await service.confirmOptions();
    await service.confirm({} as never);
    expect(keys.filter((key) => key.includes('passkey-sign-in:')).length).toBeGreaterThan(0);
    expect(keys.filter((key) => key.includes('passkey-challenge:')).length).toBeGreaterThan(0);
    expect(keys.filter((key) => !key.startsWith('guard:office|'))).toEqual([]);
  });

  it('raises the events its guard maps them to: none, or another one, but never the app\'s own', async () => {
    class Mapped {}
    const dispatched: object[] = [];
    const events = { dispatch: async (event: object) => void dispatched.push(event) } as unknown as EventDispatcher;
    const store = Object.assign(passkeyStore(), { remove: async () => ({ ok: true, value: { lastFactor: true } }) });
    const auth = { user: async () => ada, passwordRecentlyConfirmed: () => true, checkPassword: async () => ({ ok: true }), updateSessionKey: async () => true } as unknown as Auth;
    const session = await startedSession();
    const remove = (parts: GuardParts) => serviceWith(office, session, {} as RateLimiter, { events, auth, ...parts }, store).remove(1, 'secret');

    await remove({});
    expect(dispatched.map((event) => event.constructor.name), 'unmapped, as the app guard').toEqual(['PasskeyRemoved', 'TwoFactorDisabled']);

    dispatched.length = 0;
    await remove({ event: () => undefined });
    expect(dispatched, 'a guard with no events of the app\'s').toEqual([]);

    const other = new Mapped();
    await remove({ event: () => other });
    expect(dispatched).toEqual([other, other]);
  });

  it('is not built for a guard whose passkey store is missing or is not a PasskeyStore, nor takes another in its place', async () => {
    const session = await startedSession();
    expect(() => serviceFor(office, session, {} as RateLimiter, undefined)).toThrow(TypeError);
    expect(() => serviceFor(office, session, {} as RateLimiter, {})).toThrow(TypeError);
    expect(() => serviceFor(office, session, {} as RateLimiter, { forUser: async () => [] })).toThrow(TypeError);
  });
});

describe('the passkey store of the app guard', () => {
  it('is what the provider binds to APP_PASSKEY_STORE, and none without it', () => {
    const container = new Container();
    const context = new AppGuardContext(container, container);
    expect(context.passkeyStore()).toBeUndefined();
    const store = passkeyStore();
    container.instance(APP_PASSKEY_STORE, store);
    expect(context.passkeyStore()).toBe(store);
  });
});
