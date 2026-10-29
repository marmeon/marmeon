import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { I18nServiceProvider } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const routes = openRoutes((Route) => {
  Route.post('/save', () => ({ saved: true }));
});

async function post(env: Record<string, string>) {
  const application = await createApplication(
    { root: tempDir('marmeon-csrf-hint-'), discover: false, modules: [defineModule({ name: 'shop', routes })], providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, I18nServiceProvider] },
    { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', ...env } },
  );
  const kernel = createHttpKernel(application);
  const response = await kernel.request('/save', { method: 'POST', headers: { accept: 'application/json' } });
  return { status: response.status, body: (await response.json()) as { message: string } };
}

describe('the 419 of a client without a browser, with translations', () => {
  it('carries the development hint, which the translated text of the key would drop', async () => {
    const { status, body } = await post({ NODE_ENV: 'development' });
    expect(status).toBe(419);
    expect(body.message).toContain('docs/csrf.md#clients-without-a-browser');
  });

  it('is the translated plain text in production', async () => {
    expect((await post({ NODE_ENV: 'production' })).body).toEqual({ message: 'CSRF token mismatch.' });
  });
});
