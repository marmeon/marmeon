import { tempDir } from '../../../scripts/test/temp-dir.js';
import { defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const routes = openRoutes((Route) => {
  Route.get('/whoami', (ctx) => ({ ip: ctx.ip ?? null }));
});

const makeApp = (env: Record<string, string> = {}) =>
  createTestApp(
    {
      root: tempDir('marmeon-testing-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      modules: [defineModule({ name: 'whoami', routes })],
    },
    { env: { APP_KEY: generateKey(), ...env } },
  );

describe('TestApp.withIp', () => {
  it('sends the request from that client address, and a view without it has none', async () => {
    const app = await makeApp();
    const ada = await app.withIp('203.0.113.9').get('/whoami').assertOk();
    expect(ada.json()).toEqual({ ip: '203.0.113.9' });
    expect((await app.withIp('2001:db8::1').get('/whoami').assertOk()).json()).toEqual({ ip: '2001:db8::1' });
    expect((await app.get('/whoami').assertOk()).json()).toEqual({ ip: null });
  });

  it('keeps the address through other views and for stream()', async () => {
    const app = await makeApp();
    const view = app.withIp('203.0.113.9').withHeaders({ accept: 'application/json' });
    expect((await view.get('/whoami').assertOk()).json()).toEqual({ ip: '203.0.113.9' });
    expect(await (await view.stream('/whoami')).json()).toEqual({ ip: '203.0.113.9' });
  });

  it('refuses text that is not an address', async () => {
    const app = await makeApp();
    for (const bad of ['', 'localhost', '300.1.1.1', '203.0.113.9, 10.0.0.1']) expect(() => app.withIp(bad)).toThrow(TypeError);
  });

  it('goes through SERVER_TRUSTED_PROXIES like a socket: X-Forwarded-For counts only behind a trusted proxy', async () => {
    const app = await makeApp({ SERVER_TRUSTED_PROXIES: '10.0.0.0/8' });
    const forwarded = { 'x-forwarded-for': '198.51.100.7' };
    const behind = await app.withIp('10.1.2.3').withHeaders(forwarded).get('/whoami').assertOk();
    expect(behind.json()).toEqual({ ip: '198.51.100.7' });
    const direct = await app.withIp('203.0.113.9').withHeaders(forwarded).get('/whoami').assertOk();
    expect(direct.json()).toEqual({ ip: '203.0.113.9' });
  });

  it('does not make the app trust X-Forwarded-For from a request that has no address', async () => {
    const app = await makeApp({ SERVER_TRUSTED_PROXIES: '*' });
    const forged = await app.withHeaders({ 'x-forwarded-for': '198.51.100.7' }).get('/whoami').assertOk();
    expect(forged.json()).toEqual({ ip: null });
    const untrusted = await (await makeApp({ SERVER_TRUSTED_PROXIES: '10.0.0.0/8' })).withHeaders({ 'x-forwarded-for': '198.51.100.7' }).get('/whoami').assertOk();
    expect(untrusted.json()).toEqual({ ip: null });
  });
});
