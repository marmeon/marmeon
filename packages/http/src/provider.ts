import type { Application, Container, ServiceProvider } from '@bespokecore/core';
import { Encrypter } from '@bespokecore/encryption';
import { defineRoutes, GLOBAL, MiddlewarePriority, Router, type AnyMiddleware, type RouteDefinitions } from '@bespokecore/router';
import { AfterResponse } from './after-response.ts';
import { AssetVersion, CheckAssetVersion } from './asset-version.ts';
import { ClearClientHistory, ClientHistory } from './client-history.ts';
import { CookieEncryption, EncryptCookies } from './encrypt-cookies.ts';
import { DefaultExceptionHandler, ExceptionHandler } from './errors.ts';
import { ParentRequest } from './parent-request.ts';
import { ReadOnly } from './read-only.ts';
import { NO_REQUEST_INFO, RequestInfo } from './request-info.ts';
import { ResponseLifecycle } from './response-lifecycle.ts';
import { epochOfResolver, SessionEpoch, SessionEpochController } from './session-epoch.ts';
import { SharedData } from './shared-data.ts';
import { httpSolutions } from './solutions.ts';
import { ServerClosing } from './server-closing.ts';
import { UrlSigner } from './signed-urls.ts';
import { SESSION_PATH } from './tab-sync-protocol.ts';

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
    /**
     * Which named routes the browser may learn (`virtual:bespoke/routes`) — Ziggy's lesson: do not ship what the
     * browser has no business knowing. By default the named `web` routes; API routes only when listed in `include`;
     * `except` wins over both, and `.internal()` routes never go. `*` matches anything: `except: ['admin.*']`.
     * Of these, a client build ships only the names its code writes out (`<Link route>`, `useRoute()`, `useForm(name, …)`).
     * The server knows every route either way (`redirect().route()`, `router.url()`).
     */
    readonly clientRoutes?: {
      readonly include?: readonly string[];
      readonly except?: readonly string[];
    };
  }
}

/**
 * Registers the router and the exception handler, sets up the `web` and `api`
 * middleware groups and loads every module's routes — Laravel's RouteServiceProvider.
 * Discovered like any installed package through the `"bespoke"` field in this package's package.json.
 *
 * Order within `web`, whatever order packages boot in (lower priority first):
 * EncryptCookies (100) → ClearClientHistory (150) → StartSession (200) → NoStoreWhenSignedIn (210, auth)
 * → CheckAssetVersion (250) → VerifyCsrfToken (300) → shared props (400) → app middleware (1000).
 */
export class HttpServiceProvider implements ServiceProvider {
  /** "Did you mean …" for an undefined route name, a missing view (R2) — on the development error page (E130). */
  static solutions = httpSolutions;

  register(container: Container): void {
    container.singleton(Router);
    container.singleton(ExceptionHandler, DefaultExceptionHandler);
    container.singleton(CookieEncryption);
    container.scoped(SharedData);
    container.scoped(AfterResponse);
    container.scoped(ReadOnly);
    container.scoped(ParentRequest);
    container.scoped(ResponseLifecycle);
    container.scoped(ClientHistory);
    // Who sent the request (E169): the kernel binds it per request; outside one (a job, a command) nobody.
    container.scoped(RequestInfo, () => NO_REQUEST_INFO);
    container.singleton(UrlSigner);
    // The session's epoch (W8 step 8, E165): on every page object, and what `/_bespoke/session` answers.
    container.singleton(SessionEpoch);
    container.scoped(SessionEpochController, (c) => new SessionEpochController(() => epochOfResolver(c)));
    container.singleton(ServerClosing);
    container.instance(AssetVersion, { value: null }); // the server kernel sets the build's version
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
    router.middleware
      .append('web', EncryptCookies, MiddlewarePriority.encryptCookies)
      .append('web', ClearClientHistory, MiddlewarePriority.clearClientHistory)
      .append('web', CheckAssetVersion, MiddlewarePriority.checkAssetVersion);

    const { global = [], web = [], api = [] } = app.options.middleware ?? {};
    for (const middleware of global) router.middleware.append(GLOBAL, middleware);
    for (const middleware of web) router.middleware.append('web', middleware);
    for (const middleware of api) router.middleware.append('api', middleware);

    // The tabs' word from the server (W8 step 8): the epoch now — in the web group (the session and the locale say it), read-only
    // (the kernel: it starts, writes and extends no session), no name (no route manifest ships it).
    router.load(
      { group: 'web' },
      defineRoutes((Route) => {
        Route.get(SESSION_PATH, SessionEpochController).internal();
      }),
    );

    for (const module of app.modules) {
      if (module.routes) router.load({ group: 'web' }, module.routes);
      if (module.apiRoutes) router.load({ group: 'api', prefix: '/api' }, module.apiRoutes);
    }
  }
}
