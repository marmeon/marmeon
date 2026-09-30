import type { Application, Container, ServiceProvider } from '@bespokecore/core';
import { Encrypter } from '@bespokecore/encryption';
import { GLOBAL, MiddlewarePriority, Router, type AnyMiddleware, type RouteDefinitions } from '@bespokecore/router';
import { CookieEncryption, EncryptCookies } from './encrypt-cookies.ts';
import { DefaultExceptionHandler, ExceptionHandler } from './errors.ts';

declare module '@bespokecore/core' {
  interface ModuleDefinition {
    /** The module's routes: middleware group `web` (cookies, session, CSRF). */
    readonly routes?: RouteDefinitions;
    /** Stateless API routes: middleware group `api`, prefixed with `/api`. */
    readonly apiRoutes?: RouteDefinitions;
  }

  interface ApplicationOptions {
    /**
     * App middleware, added after the framework's own (Laravel's `withMiddleware`):
     * `global` runs for every request — unmatched ones included — `web` / `api` for their routes.
     */
    readonly middleware?: {
      readonly global?: readonly AnyMiddleware[];
      readonly web?: readonly AnyMiddleware[];
      readonly api?: readonly AnyMiddleware[];
    };
  }
}

/**
 * Registers the router and the exception handler, sets up the `web` and `api`
 * middleware groups and loads every module's routes — Laravel's RouteServiceProvider.
 * Discovered like any installed package through the `"bespoke"` field in this package's package.json.
 *
 * Order within `web`, whatever order packages boot in (lower priority first):
 * EncryptCookies (100) → StartSession (200) → VerifyCsrfToken (300) → shared props (400) → app middleware (1000).
 */
export class HttpServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(Router);
    container.singleton(ExceptionHandler, DefaultExceptionHandler);
    container.singleton(CookieEncryption);
  }

  boot(app: Application): void {
    // The `web` group encrypts cookies: fail at boot, not with a 500 on the first request.
    if (!app.container.has(Encrypter)) {
      throw new Error(
        'The web middleware group needs the Encrypter — register EncryptionServiceProvider from @bespokecore/encryption ' +
          '(discovery does this automatically) and set APP_KEY.',
      );
    }
    const router = app.container.make(Router);
    router.middleware.append('web', EncryptCookies, MiddlewarePriority.encryptCookies);

    const { global = [], web = [], api = [] } = app.options.middleware ?? {};
    for (const middleware of global) router.middleware.append(GLOBAL, middleware);
    for (const middleware of web) router.middleware.append('web', middleware);
    for (const middleware of api) router.middleware.append('api', middleware);

    for (const module of app.modules) {
      if (module.routes) router.load({ group: 'web' }, module.routes);
      if (module.apiRoutes) router.load({ group: 'api', prefix: '/api' }, module.apiRoutes);
    }
  }
}
