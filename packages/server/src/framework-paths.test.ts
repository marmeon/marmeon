import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, SESSION_PATH } from '@marmeon/http';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

async function kernelFor(routes: ReturnType<typeof openRoutes>) {
  const app = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' },
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'greedy', routes })],
  });
  return createHttpKernel(app);
}

describe('framework routes against greedy app routes', () => {
  it.each([
    ['a catch-all parameter', '/:page{.+}', '/some/page'],
    ['a wildcard', '/*', '/some/page'],
    ['a parameter before a literal', '/:a/session', '/x/session'],
  ])('are not hidden by %s', async (_name, path, other) => {
    const kernel = await kernelFor(
      openRoutes((Route) => {
        Route.get(path, () => 'app');
      }),
    );
    const response = await kernel.request(SESSION_PATH);
    expect(response.headers.get('content-type')).toMatch(/json/);
    expect(await response.json()).toHaveProperty('epoch');
    // The app's own route still answers everything else.
    expect(await (await kernel.request(other)).text()).toBe('app');
  });
});
