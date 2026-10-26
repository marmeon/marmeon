import type { Session } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import * as authEntry from './index.ts';
import { abilities, EverySessionEnded } from './index.ts';
import { AUTH_SESSION_KEYS, readAuth, writeAuth } from './session-keys.ts';
import * as twoFactorEntry from './two-factor/index.ts';

const counts = { accounts: 1, resetTokens: 2, accessTokens: 3, signIns: 4 };

/** Runs the middleware `abilities()` makes against a token with these abilities. */
async function through(middleware: ReturnType<typeof abilities>, granted: string[]): Promise<number> {
  const handler = new (middleware as unknown as new () => { handle(ctx: unknown, next: () => Response): Promise<Response> | Response })();
  const response = await handler.handle({ token: { abilities: granted } }, () => new Response(null, { status: 204 }));
  return response.status;
}

describe('abilities()', () => {
  it('names at least one ability: a call without a name, or with an empty one, throws', () => {
    // @ts-expect-error — a route every token may call needs no abilities()
    expect(() => abilities()).toThrow(/name at least one ability/);
    expect(() => abilities('')).toThrow(TypeError);
    expect(() => abilities('users:read', '')).toThrow(TypeError);
    expect(() => abilities(1 as never)).toThrow(TypeError);
  });

  it('lets a token with the ability through and refuses one without', async () => {
    const check = abilities('users:read');
    expect(await through(check, ['users:read'])).toBe(204);
    expect(await through(check, ['users:write'])).toBe(403);
    expect(await through(check, [])).toBe(403);
    expect(await through(abilities('a', 'b'), ['a'])).toBe(403);
  });
});

describe('EverySessionEnded', () => {
  it('takes the counts first and the time last', () => {
    const at = new Date('2030-01-01T00:00:00Z');
    expect(new EverySessionEnded(counts, at)).toMatchObject({ ...counts, at });
    expect(new EverySessionEnded(counts).at).toBeInstanceOf(Date);
    // @ts-expect-error — the counts come first
    expect(() => new EverySessionEnded(at, counts)).toThrow(TypeError);
  });
});

describe('the entry points', () => {
  it('export no constant for the proof that a change of factors asks for, and no session key', () => {
    expect(Object.keys(twoFactorEntry).filter((name) => name.startsWith('FACTOR_CHANGE'))).toEqual([]);
    expect(Object.keys(authEntry).filter((name) => name.startsWith('FACTOR_CHANGE') || name === 'AUTH_SESSION_KEYS')).toEqual([]);
  });
});

describe('the sign-in keys of the session', () => {
  it('are written and read through their own typed access', () => {
    const stored = new Map<string, unknown>();
    const session = { get: (key: string) => stored.get(key), put: (key: string, value: unknown) => void stored.set(key, value) } as unknown as Session;
    writeAuth(session, 'confirmedAt', 1700000000);
    expect(stored.get('_auth_confirmed_at')).toBe(1700000000);
    expect(readAuth(session, 'confirmedAt')).toBe(1700000000);
    expect(Object.values(AUTH_SESSION_KEYS).every((key) => key.startsWith('_'))).toBe(true);
    // @ts-expect-error — the value of a key has the type of that key
    writeAuth(session, 'confirmedAt', 'yesterday');
  });
});
