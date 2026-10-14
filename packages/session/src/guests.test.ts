import { readdirSync } from 'node:fs';
import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, ValidationError, view, type PageObject } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionServiceProvider } from './provider.ts';
import { SessionStore } from './store.ts';
import { redisConnections, storeKinds, storeUnderTest, type StoreUnderTest } from './__fixtures__/stores.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const routes = openRoutes((Route) => {
  Route.get('/login', () => view('auth/Login', {}));
  Route.post('/login', () => {
    throw new ValidationError({ email: ['These credentials do not match our records.'] }, { email: 'ada@example.com' });
  });
});

/** How many sessions the store holds — counted where it keeps them (the memory store: by its writes). */
async function stored(current: StoreUnderTest, writes: number): Promise<number> {
  const { target } = current;
  switch (target.kind) {
    case 'memory':
      return writes;
    case 'file':
      return readdirSync(target.directory).length;
    case 'sqlite':
    case 'pgsql':
      return current.rows();
    case 'redis': {
      const redis = redisConnections(target.url, target.prefix);
      try {
        return (await redis.get().command<string[]>(['KEYS', `${target.prefix}*`])).length;
      } finally {
        await redis.close();
      }
    }
  }
}

// A guest's page keeps no session — on every store. A failed form is the first write.
describe.each(storeKinds)('guests and the %s session store', (kind) => {
  let current: StoreUnderTest | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it('100 guests on the login page leave nothing behind — no session, no cookie, no token in the page; a failed sign-in keeps one', async () => {
    current = await storeUnderTest(kind);
    let writes = 0;
    const store = current.store;
    const counting: SessionStore = {
      read: (key) => store.read(key),
      write: (key, data, options) => (writes++, store.write(key, data, options)),
      destroy: (key) => store.destroy(key),
      gc: (lifetime) => store.gc(lifetime),
    };
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
      modules: [defineModule({ name: 'auth', routes })],
      override: (container) => void container.instance(SessionStore, counting),
    });
    const kernel = createHttpKernel(application);

    const pages = await Promise.all(Array.from({ length: 100 }, (_, i) => kernel.request('/login', { headers: i % 2 ? { 'x-marmeon': 'true' } : { accept: 'application/json', 'x-marmeon': 'true' } })));
    for (const page of pages) {
      expect(page.status).toBe(200);
      expect(page.headers.getSetCookie()).toEqual([]);
      expect(((await page.json()) as PageObject).csrf).toBeUndefined();
    }
    expect([writes, await stored(current, writes)]).toEqual([0, 0]);

    const failed = await kernel.request('/login', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', accept: 'text/html' }, body: new URLSearchParams({ email: 'ada@example.com' }) });
    expect(failed.status).toBe(303);
    expect(failed.headers.getSetCookie().some((cookie) => cookie.startsWith('marmeon_session='))).toBe(true);
    expect([writes, await stored(current, writes)]).toEqual([1, 1]);
    await application.shutdown();
  });
});
