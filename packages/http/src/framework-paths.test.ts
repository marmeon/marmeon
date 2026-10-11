import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineRoutes, Router } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { SESSION_PATH } from './tab-sync-protocol.ts';
import { HttpServiceProvider } from './provider.ts';

const boot = (name: string, routes: ReturnType<typeof defineRoutes>, key: 'routes' | 'apiRoutes' = 'routes') =>
  createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' },
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name, [key]: routes })],
  });

describe('the framework’s paths', () => {
  it('stop an app whose module hides the session route', async () => {
    const hiding = defineRoutes((Route) => {
      Route.get('/_marmeon/session', () => ({ epoch: 'fixed' }));
    });
    await expect(boot('hiding', hiding)).rejects.toThrow(/GET \/_marmeon\/session: paths under \/_marmeon\/ belong to the framework/);
  });

  it('stop an app whose route spells the prefix in another case', async () => {
    const api = defineRoutes((Route) => {
      Route.get('/x', () => 'x');
    });
    // API routes get `/api` from the framework, which keeps them clear of the prefix.
    await expect(boot('api', api, 'apiRoutes')).resolves.toBeDefined();
    const spelled = defineRoutes((Route) => {
      Route.get('/_MarMeon/live', () => 'x');
    });
    await expect(boot('spelled', spelled)).rejects.toThrow(/belong to the framework/);
  });

  it('still serve the framework’s own session route', async () => {
    const application = await boot('plain', defineRoutes((Route) => Route.get('/plain', () => 'x')));
    expect(application.container.make(Router).routes.map((route) => route.path)).toContain(SESSION_PATH);
  });
});
