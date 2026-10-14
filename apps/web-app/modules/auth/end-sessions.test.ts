import { Logger } from '@marmeon/core';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { EndSessionsCommand } from './commands/EndSessionsCommand.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
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
    const session = laptop.cookie('marmeon_session')!;
    const remember = laptop.cookie('remember_web')!;
    const bobs = (await signIn(bob.email)).cookie('marmeon_session')!;
    await app.withCookie('marmeon_session', session).get('/users/me').assertAuthenticated(ada);

    const info = vi.spyOn(app.make(Logger), 'info');
    const done = await run([` ${ada.email.toUpperCase()} `]);
    expect(done.code).toBe(0);
    expect(done.lines[0]).toContain(`of ${ada.email};`);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('every session'), { userId: ada.id });

    await app.withCookie('marmeon_session', session).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie('remember_web', remember).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie('marmeon_session', bobs).get('/users/me').assertAuthenticated(bob);
    // The password still signs in.
    await signIn(ada.email).assertRedirect('/users/me');
  });

  it('changes nothing without --force', async () => {
    const ada = await app.factory(UserFactory).create();
    const laptop = await signIn(ada.email, { remember: 'on' });
    const refused = await run([ada.email], {});
    expect(refused.code).toBe(1);
    expect(refused.lines[0]).toContain('pass --force');
    await app.withCookie('marmeon_session', laptop.cookie('marmeon_session')!).get('/users/me').assertAuthenticated(ada);
    await app.withCookie('remember_web', laptop.cookie('remember_web')!).get('/users/me').assertAuthenticated(ada);
  });

  it('says so for an unknown address or none', async () => {
    expect(await run(['nobody@example.com'])).toEqual({ code: 1, lines: ['No account has the address nobody@example.com.'] });
    expect((await run([])).code).toBe(1);
  });
});
