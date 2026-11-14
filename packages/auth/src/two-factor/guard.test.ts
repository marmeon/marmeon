import type { RateLimiter } from '@marmeon/cache';
import type { EventDispatcher } from '@marmeon/core';
import type { Encrypter } from '@marmeon/encryption';
import type { ClientInfo } from '@marmeon/http';
import type { CookieJar, Router } from '@marmeon/router';
import { Session, type SessionConfig } from '@marmeon/session';
import { MemorySessionStore, plainSessionCodec } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import type { Auth } from '../auth.ts';
import { APP_GUARD_NAMES, guardNames, type GuardNames } from '../guard-names.ts';
import { guardContext, type GuardParts } from '../test-helpers/guard-context.ts';
import { twoFactorState } from '../test-helpers/stores.ts';
import type { AuthUser } from '../user.ts';
import { confirmedSecondFactor } from './confirmed.ts';
import { twoFactor } from './middleware.ts';
import type { TwoFactorStore } from './store.ts';
import { TwoFactor } from './two-factor.ts';

const ada = { id: 1, name: 'Ada', email: 'ada@example.com' } as AuthUser & { id: number };
const office = guardNames('office');
const factors = twoFactorState({ factors: async () => ['totp'] });

async function startedSession(): Promise<Session> {
  const session = new Session(new MemorySessionStore(), { lifetimeMinutes: 120 } as SessionConfig, plainSessionCodec);
  await session.start();
  return session;
}

/** A limiter that records the keys it was asked about and lets everything through. */
function recordingLimiter(): { limiter: RateLimiter; keys: string[] } {
  const keys: string[] = [];
  const limiter = {
    attempt: async (key: string) => (keys.push(key), true),
    attempts: async (key: string) => (keys.push(key), 0),
    clear: async (key: string) => void keys.push(key),
    availableInSeconds: async () => 0,
  } as unknown as RateLimiter;
  return { limiter, keys };
}

const contextOf = (names: GuardNames, parts: GuardParts = {}) =>
  guardContext({
    names,
    factors,
    totp: { consumeRecoveryCode: async () => 5, find: async () => undefined } as unknown as TwoFactorStore,
    users: { findById: async () => ({ user: ada, passwordHash: null, sessionKey: null }) } as never,
    auth: { user: async () => ada } as unknown as Auth,
    ...parts,
  });

function serviceFor(names: GuardNames, session: Session, limiter: RateLimiter, parts: GuardParts = {}): TwoFactor {
  return new TwoFactor(contextOf(names, parts), session, {} as Encrypter, limiter, { ip: '203.0.113.9', userAgent: 'test' } as ClientInfo, {} as CookieJar, { secure: false } as SessionConfig);
}

describe('TwoFactor for a guard', () => {
  it('counts its attempts under the names of its guard, never under the app guard\'s', async () => {
    const { limiter, keys } = recordingLimiter();
    const result = await serviceFor(office, await startedSession(), limiter).stepUp({ recoveryCode: 'ABCD-EFGH-IJKL-MNOP' });
    expect(result.ok).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !key.startsWith('guard:office|two-factor-recovery:'))).toEqual([]);

    const app = recordingLimiter();
    await serviceFor(APP_GUARD_NAMES, await startedSession(), app.limiter).stepUp({ recoveryCode: 'ABCD-EFGH-IJKL-MNOP' });
    expect(app.keys.every((key) => key.startsWith('two-factor-recovery:'))).toBe(true);
  });

  it('counts the attempts at a code in all three windows under its guard\'s names', async () => {
    const { limiter, keys } = recordingLimiter();
    const result = await serviceFor(office, await startedSession(), limiter).stepUp({ code: '000000' });
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-code' } });
    for (const window of ['minute', 'hour', 'day']) expect(keys, window).toContain(`guard:office|two-factor-${window}:1`);
    expect(keys.filter((key) => !key.startsWith('guard:office|'))).toEqual([]);
  });

  it('marks the proof of a second factor in the session of its guard only', async () => {
    const session = await startedSession();
    expect((await serviceFor(office, session, recordingLimiter().limiter).stepUp({ recoveryCode: 'ABCD-EFGH-IJKL-MNOP' })).ok).toBe(true);
    expect(session.has('_auth:office:two_factor_at')).toBe(true);
    expect(session.has('_auth_two_factor_at'), 'the app guard has proven nothing').toBe(false);
  });

  it('raises the events its guard maps them to: none, or another one, but never the app\'s own', async () => {
    class Mapped {}
    const dispatched: object[] = [];
    const events = { dispatch: async (event: object) => void dispatched.push(event) } as unknown as EventDispatcher;
    // A valid recovery code raises `RecoveryCodeUsed`; a wrong one, `TwoFactorChallengeFailed`.
    const session = await startedSession();
    const use = (parts: GuardParts, remaining: number | undefined) =>
      serviceFor(office, session, recordingLimiter().limiter, { events, totp: { consumeRecoveryCode: async () => remaining, find: async () => undefined } as unknown as TwoFactorStore, ...parts }).stepUp({ recoveryCode: 'ABCD-EFGH-IJKL-MNOP' });

    await use({}, 5);
    await use({}, undefined);
    expect(dispatched.map((event) => event.constructor.name), 'unmapped, as the app guard').toEqual(['RecoveryCodeUsed', 'TwoFactorChallengeFailed']);

    dispatched.length = 0;
    await use({ event: () => undefined }, 5);
    await use({ event: () => undefined }, undefined);
    expect(dispatched, 'a guard with no events of the app\'s').toEqual([]);

    const other = new Mapped();
    await use({ event: () => other }, 5);
    expect(dispatched).toEqual([other]);
  });

  it('is not built for a guard that has no TwoFactorStore', () => {
    const context = guardContext({ names: office });
    expect(() => new TwoFactor(context, {} as Session, {} as Encrypter, {} as RateLimiter, {} as ClientInfo, {} as CookieJar, { secure: false } as SessionConfig)).toThrow(TypeError);
  });
});

describe.each([
  ['twoFactor()', () => twoFactor({ setup: 'test.setup', verify: 'test.verify' })],
  ['confirmedSecondFactor()', () => confirmedSecondFactor({ verify: 'test.verify' })],
])('%s for a guard', (_name, middleware) => {
  /** The status of the request after the middleware, or `next` when it let it through. */
  async function run(names: GuardNames, session: Session): Promise<number> {
    const Class = middleware() as unknown as new (...parameters: unknown[]) => { handle(ctx: unknown, next: () => Promise<Response>): Promise<Response> };
    const instance = new Class(contextOf(names), session, {} as Router);
    const response = await instance.handle({ expectsJson: () => true, request: new Request('https://example.com/') }, async () => new Response('next'));
    return response.status;
  }

  it('reads the proof of its own guard: another guard\'s, or the app\'s, opens nothing', async () => {
    const session = await startedSession();
    session.put('_auth:office:two_factor_at', Math.floor(Date.now() / 1000));
    expect(await run(office, session)).toBe(200);
    expect(await run(APP_GUARD_NAMES, session), 'the app guard').toBe(403);
    expect(await run(guardNames('shop'), session), 'another guard').toBe(403);

    const appSession = await startedSession();
    appSession.put('_auth_two_factor_at', Math.floor(Date.now() / 1000));
    expect(await run(office, appSession), 'a proof of the app guard').toBe(403);
  });
});
