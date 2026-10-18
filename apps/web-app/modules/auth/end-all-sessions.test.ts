import { AccountSessions } from '@marmeon/auth';
import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { UserRepository } from './UserRepository.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
let SESSION: string;
let REMEMBER: string;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
  ({ session: SESSION, remember: REMEMBER } = cookieNames(app));
});

describe('UserRepository.updateEverySessionKey()', () => {
  const key = 'k'.repeat(43);

  it('writes one key into every account and names one of them', async () => {
    const users = app.make(UserRepository);
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const before = (await users.findById(ada.id))?.sessionKey;

    const written = await users.updateEverySessionKey(key);
    expect(written.accounts).toBe(2);
    expect([ada.id, bob.id]).toContain(written.sampleId);
    expect((await users.findById(ada.id))?.sessionKey).toBe(key);
    expect((await users.findById(bob.id))?.sessionKey).toBe(key);
    expect((await users.findById(written.sampleId!))?.sessionKey).toBe(key);
    expect(before).not.toBe(key);
  });

  it('answers no account and no sample for an empty table', async () => {
    expect(await app.make(UserRepository).updateEverySessionKey(key)).toEqual({ accounts: 0, sampleId: undefined });
  });

  it('refuses a key too short to be random', async () => {
    await expect(app.make(UserRepository).updateEverySessionKey('short')).rejects.toThrow('at least 32');
  });
});

describe('AccountSessions.endEveryone() with the app\'s repository', () => {
  const signIn = (email: string, extra: Record<string, string> = {}) => app.post('/login', { form: { email, password: 'password', ...extra } });

  it('signs two browsers of two accounts out, remember-me included, and lets a new sign-in through', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const laptop = await signIn(ada.email, { remember: 'on' });
    const session = laptop.cookie(SESSION)!;
    const remember = laptop.cookie(REMEMBER)!;
    const bobs = [(await signIn(bob.email)).cookie(SESSION)!, (await signIn(bob.email)).cookie(SESSION)!];
    await app.withCookie(SESSION, session).get('/users/me').assertAuthenticated(ada);
    for (const cookie of bobs) await app.withCookie(SESSION, cookie).get('/users/me').assertAuthenticated(bob);

    expect(await app.make(AccountSessions).endEveryone()).toMatchObject({ accounts: 2, signIns: 3 });

    await app.withCookie(SESSION, session).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie(REMEMBER, remember).expectingJson().get('/users/me').assertUnauthorized();
    for (const cookie of bobs) await app.withCookie(SESSION, cookie).expectingJson().get('/users/me').assertUnauthorized();
    await signIn(ada.email).assertRedirect('/users/me');
  });
});
