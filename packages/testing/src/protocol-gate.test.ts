import { tempDir } from '../../../scripts/test/temp-dir.js';
import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, type HttpContext, type Next } from '@marmeon/http';
import { PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const ran = { web: 0, controller: 0 };

/** On the web group, with the session and the CSRF check: whatever it counts, the gate has not kept it from running. */
class CountWeb {
  handle(_ctx: HttpContext, next: Next<{}>) {
    ran.web++;
    return next();
  }
}

const definition: ApplicationDefinition = {
  root: tempDir('marmeon-testing-'),
  discover: false,
  providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
  middleware: { web: [CountWeb] },
  modules: [
    defineModule({
      name: 'gate',
      routes: openRoutes((Route) => {
        Route.post('/things', () => (ran.controller++, Response.json({ ok: true })));
      }),
    }),
  ],
};

const env = { APP_KEY: generateKey(), SESSION_DRIVER: 'memory' };

describe('the protocol gate in front of the session and the CSRF check', () => {
  it('is a plain 409 — no session started, no cookie, no 419, no middleware, no controller', async () => {
    const app = await createTestApp(definition, { env, csrf: true });
    // The check is on: a form without a token is refused with 419.
    ran.web = ran.controller = 0;
    await app.post('/things', { form: { a: '1' } }).assertStatus(419);
    expect(ran.controller).toBe(0);

    const stale: Record<string, string>[] = [{ 'x-marmeon': 'true' }, { 'x-marmeon': '2' }, { 'x-marmeon-action': 'true' }, { 'x-marmeon-validate': 'a' }];
    for (const headers of stale) {
      ran.web = ran.controller = 0;
      const response = await app.withHeaders(headers).post('/things', { form: { a: '1' } }).assertStatus(409);
      expect([ran.web, ran.controller]).toEqual([0, 0]);
      expect(response.headers.getSetCookie()).toEqual([]);
    }

    // The supported version goes on to the CSRF check.
    await app.withHeaders({ 'x-marmeon': PROTOCOL_VERSION }).post('/things', { form: { a: '1' } }).assertStatus(419);
  });
});

describe('the CSRF check in a test app', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is off by default, also when the process has no NODE_ENV', async () => {
    vi.stubEnv('NODE_ENV', undefined);
    const app = await createTestApp(definition, { env });
    await app.post('/things', { form: { a: '1' } }).assertOk();
  });

  it('stays on in a test app that runs as production', async () => {
    const app = await createTestApp(definition, { env: { ...env, NODE_ENV: 'production' } });
    await app.post('/things', { form: { a: '1' } }).assertStatus(419);
  });
});
