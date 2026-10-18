import { Logger } from '@marmeon/core';
import { EndSessionsCommand } from '@marmeon/auth';
import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
let SESSION: string;
let REMEMBER: string;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
  ({ session: SESSION, remember: REMEMBER } = cookieNames(app));
});

describe('marmeon auth:end-sessions', () => {
  const run = async (args: string[], options: Record<string, boolean> = { force: true }) => {
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    const code = await app.make(EndSessionsCommand).handle({ args, options, output } as never);
    return { code, lines };
  };
  const signIn = (email: string, extra: Record<string, string> = {}) => app.post('/login', { form: { email, password: 'password', ...extra } });

  it('ends a session and a remember-me cookie, and no other account\'s', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const laptop = await signIn(ada.email, { remember: 'on' });
    const session = laptop.cookie(SESSION)!;
    const remember = laptop.cookie(REMEMBER)!;
    const bobs = (await signIn(bob.email)).cookie(SESSION)!;
    await app.withCookie(SESSION, session).get('/users/me').assertAuthenticated(ada);

    const info = vi.spyOn(app.make(Logger), 'info');
    const done = await run([` ${ada.email} `]);
    expect(done.code).toBe(0);
    expect(done.lines[0]).toContain(`of ${ada.email};`);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('every session'), { userId: ada.id });

    await app.withCookie(SESSION, session).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie(REMEMBER, remember).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie(SESSION, bobs).get('/users/me').assertAuthenticated(bob);
    // The password still signs in.
    await signIn(ada.email).assertRedirect('/users/me');
  });

  it('changes nothing without --force', async () => {
    const ada = await app.factory(UserFactory).create();
    const laptop = await signIn(ada.email, { remember: 'on' });
    const refused = await run([ada.email], {});
    expect(refused.code).toBe(1);
    expect(refused.lines[0]).toContain('pass --force');
    await app.withCookie(SESSION, laptop.cookie(SESSION)!).get('/users/me').assertAuthenticated(ada);
    await app.withCookie(REMEMBER, laptop.cookie(REMEMBER)!).get('/users/me').assertAuthenticated(ada);
  });

  it('says so for an unknown address or none', async () => {
    expect(await run(['nobody@example.com'])).toEqual({ code: 1, lines: ['No account has the identifier nobody@example.com: the lookup is exact (only trimmed), so type it as it is stored, e.g. nobody@example.com.'] });
    expect((await run([])).code).toBe(1);
  });
});
