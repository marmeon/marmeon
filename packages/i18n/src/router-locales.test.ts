import { join } from 'node:path';
import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { defineRoutes, everyone, Router } from '@marmeon/router';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it, onTestFinished } from 'vitest';
import { I18nServiceProvider } from './index.ts';

const root = join(import.meta.dirname, '__fixtures__', 'shop');
const routes = defineRoutes((Route) => void Route.localized().authorize(everyone).get('/', () => ({ home: true })));

/** The router of an app booted without a kernel, as a command sees it. */
async function bootedRouter(env: Record<string, string>): Promise<Router> {
  const application = await createApplication({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, I18nServiceProvider],
    modules: [defineModule({ name: 'shop', routes })],
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', ...env } });
  onTestFinished(() => application.shutdown());
  return application.container.make(Router);
}

describe('the router told by I18nServiceProvider', () => {
  const claim = { by: 'route' };

  it('answers claimedBy() by the locales of the app once booted, with no kernel started', async () => {
    const router = await bootedRouter({ APP_LOCALES: 'de,en' });
    expect(router.claimedBy('/about')).toBeUndefined();
    expect(router.claimedBy('/de')).toMatchObject(claim);
    expect(router.claimedBy('/en')).toMatchObject(claim);
    expect(router.claimedBy('/fr')).toBeUndefined();
    expect(router.claimedBy('/')).toMatchObject(claim);
  });

  it('counts the locales of the language files when APP_LOCALES names none', async () => {
    const router = await bootedRouter({});
    expect(router.claimedBy('/fr')).toMatchObject(claim);
    expect(router.claimedBy('/xx')).toBeUndefined();
  });
});
