import { describe, expect, it } from 'vitest';
import { plainSessionCodec } from './codec.ts';
import type { SessionConfig } from './config.ts';
import { sessionScope } from './ended.ts';
import { pageSessionOf } from './provider.ts';
import { Session } from './session.ts';
import { guardUserKey, isSessionIdentityKey, SESSION_USER_KEY } from './store.ts';
import { MemorySessionStore } from './stores/memory.ts';

const config = { lifetimeMinutes: 120 } as SessionConfig;

async function started() {
  const session = new Session(new MemorySessionStore(), config, plainSessionCodec);
  await session.start(undefined);
  return session;
}

describe('isSessionIdentityKey()', () => {
  it('knows the app guard’s key and the key of every package guard, and nothing else', () => {
    expect(isSessionIdentityKey(SESSION_USER_KEY)).toBe(true);
    expect(isSessionIdentityKey(guardUserKey('office'))).toBe(true);
    expect(isSessionIdentityKey(guardUserKey('back-office'))).toBe(true);
    for (const key of ['_auth_password', '_auth:office:password', '_auth:office:id:x', '_auth::id', '_auth:Office:id', 'auth:office:id', ' _auth:office:id', '_auth:office:id\n', 'user_id', '']) {
      expect(isSessionIdentityKey(key), key).toBe(false);
    }
  });
});

describe('Session.identityKeys()', () => {
  it('lists the keys of the guards that signed somebody in: the app’s first, then the others sorted', async () => {
    const session = await started();
    session.put(guardUserKey('shop'), 3);
    session.put(guardUserKey('office'), 2);
    session.put('_auth_password', 'x');
    session.put(SESSION_USER_KEY, 1);
    expect(session.identityKeys()).toEqual(['_auth_id', '_auth:office:id', '_auth:shop:id']);
  });
});

describe('PageSession.generation()', () => {
  const generation = (session: Session) => pageSessionOf(session).generation();

  it('is none for a guest and, for the app guard’s user, the scope and the id as it always was', async () => {
    const session = await started();
    expect(generation(session)).toBeUndefined();
    session.put(SESSION_USER_KEY, 1);
    expect(generation(session)).toBe(`${sessionScope(session.id)}\n1`);
  });

  it('changes when only a package guard signs in, so other tabs reload', async () => {
    const session = await started();
    const guest = generation(session);
    session.put(guardUserKey('office'), 5);
    const signedIn = generation(session);
    expect(guest).toBeUndefined();
    expect(signedIn).toMatch(/\n_auth:office:id=5$/);
    session.put(guardUserKey('shop'), 5);
    expect(generation(session)).not.toBe(signedIn);
  });

  it('changes when a guard signs in next to the app guard, and tells the guards apart', async () => {
    const session = await started();
    session.put(SESSION_USER_KEY, 1);
    const appOnly = generation(session);
    session.put(guardUserKey('office'), 1);
    const both = generation(session);
    expect(both).not.toBe(appOnly);
    session.forget(SESSION_USER_KEY);
    expect(generation(session)).not.toBe(both);
  });
});
