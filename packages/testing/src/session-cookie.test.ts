import { tempDir } from '../../../scripts/test/temp-dir.js';
import { defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { sessionCookieName, SessionConfig, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const routes = openRoutes((Route) => {
  Route.get('/ping', () => ({ ok: true }));
});

describe('the session cookie of a response', () => {
  it('is the one the request came with when the session kept its id, and its data is read from it', async () => {
    const app = await createTestApp(
      {
        root: tempDir('marmeon-testing-'),
        discover: false,
        providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
        modules: [defineModule({ name: 'ping', routes })],
      },
      { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory' } },
    );
    const name = sessionCookieName(app.make(SessionConfig));
    const first = await app.withSession({ who: 'ada' }).get('/ping').assertOk();
    // The server sends no cookie for a session the browser already holds.
    expect(first.headers.getSetCookie().some((cookie) => cookie.startsWith(`${name}=`))).toBe(false);
    const held = first.cookie(name);
    expect(held).toBeTypeOf('string');
    expect(first.session()).toMatchObject({ who: 'ada' });
    // Carried by hand into the next request, it is the same session.
    const next = await app.withCookie(name, held!).get('/ping').assertOk();
    expect(next.cookie(name)).toBe(held);
    expect(next.session()).toMatchObject({ who: 'ada' });
  });

  it('counts a cookie the app ignored as no session: a forged, unencrypted id is nobody\'s, and only the session cookie is held', async () => {
    const app = await createTestApp(
      {
        root: tempDir('marmeon-testing-'),
        discover: false,
        providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
        modules: [defineModule({ name: 'ping', routes })],
      },
      { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory' } },
    );
    const name = sessionCookieName(app.make(SessionConfig));
    const real = (await app.withSession({ who: 'ada' }).get('/ping').assertOk()).cookie(name)!;
    const forged = await app.withUnencryptedCookie(name, real).get('/ping').assertOk();
    expect(forged.cookie(name)).toBeUndefined();
    expect(() => forged.session()).toThrow('carry a session');
    const other = await app.withCookie('theme', 'dark').get('/ping').assertOk();
    expect(other.cookie('theme')).toBeUndefined();
  });
});
